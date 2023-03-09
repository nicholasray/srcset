import { filesize } from "filesize";
import * as fs from "fs";
import fsExtra from "fs-extra";
import { gzipSize } from "gzip-size";
import path from "node:path";
import { Browser, chromium, devices } from "playwright";
import { max, median } from "simple-statistics";
import transforms from "./transforms/index.js";
import slugify from "slugify";
import tablemark from "tablemark";
import { fileURLToPath } from "url";
import topViews from "./topviews-2023_02.json" assert { type: "json" };
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ARTICLE_COUNT = 100;
const SECTIONS_CLICKED: number | "all" = 0;
const BATCH_SIZE = 10;

interface Transformer {
  name: string;
  getArgs: Function;
  transform: Function;
}

/**
 * Scrolls to the bottom of the page.
 */
async function scrollToBottom() {
  const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  for (let i = 0; i < document.body.scrollHeight; i += 100) {
    window.scrollTo(0, i);
    await delay(20);
  }
}

/**
 * Creates a browser using iPhone 11 context.
 */
async function createContext(browser: Browser, opts = {}) {
  return await browser.newContext({
    ...devices["iPhone 11"],
    deviceScaleFactor: 2,
    ...opts,
  });
}

/**
 * Visits a url, clicks a number of sections, scrolls to the bottom of the page,
 * and sums the downloaded html and image transfers.
 */
async function visitPage(
  browser: Browser,
  url: string,
  slug: string,
  saveFolder: string
) {
  const context = await createContext(browser, {});
  const page = await context.newPage();
  console.log(`Visiting ${slug} and saving image to ${saveFolder}`);

  // Sum response size of all image requests.
  let imageTransferSize = 0;

  page.on("requestfinished", async (request) => {
    if (request.resourceType() === "image") {
      const sizes = await request.sizes();
      imageTransferSize += sizes.responseHeadersSize + sizes.responseBodySize;
    }
  });

  await page.goto(url, { waitUntil: "networkidle" });
  let htmlResponseText = await page.content();

  // Find first paragraph so we can roughly estimate impact of largest contentful paint.
  const firstParagraph = await page
    .locator("p:not(.mw-empty-elt)")
    .first()
    .evaluate((elem) => elem.outerHTML);

  const endOfFirstParagraphHtml =
    htmlResponseText.split(firstParagraph).shift() + firstParagraph;

  await fs.promises.writeFile(
    path.join(__dirname, `/pages/${saveFolder}/p-${slug}.html`),
    endOfFirstParagraphHtml
  );

  // Click first section
  let sections = await page
    .locator(".mw-parser-output > .collapsible-heading")
    .all();

  if (sections.length) {
    for (
      let i = 0;
      i < (SECTIONS_CLICKED === "all" ? sections.length : SECTIONS_CLICKED);
      i++
    ) {
      await sections[i].click();
    }
  }
  await page.evaluate(scrollToBottom);
  // Wait for images to load.
  await page.waitForTimeout(3000);
  await page.screenshot({
    path: path.join(__dirname, `/pages/${saveFolder}/${slug}.jpg`),
  });

  // Teardown
  await context.close();

  return {
    imageTransferSize,
    htmlSizeParagraph: Buffer.byteLength(endOfFirstParagraphHtml, "utf8"),
    htmlTransferSizeParagraph: await gzipSize(endOfFirstParagraphHtml),
    htmlSize: Buffer.byteLength(htmlResponseText, "utf8"),
    htmlTransferSize: await gzipSize(htmlResponseText),
  };
}

const makePage = async (context, host, path) => {
  const page = await context.newPage();
  await page.goto(`${host}/${path}`, {
    waitUntil: "load",
  });
  await page.evaluate((host) => {
    const base = document.createElement("base");
    base.href = host;
    document.head.prepend(base);
  }, host);
  return page;
};

/**
 * Create two versions of the same page — one version will contain lazy loaded
 * images without the srcset attribute, the other version will contain lazy
 * loaded images with the srcset attribute.
 */
async function createVersions(
  browser: Browser,
  slug: string,
  transformer: Transformer,
  host: string
) {
  const context = await createContext(browser, {
    javaScriptEnabled: false,
  });
  const page = await makePage(context, host, `wiki/${slug}`);
  const beforeHtml = await page.content();
  const beforePath = path.join(
    __dirname,
    `/pages/${transformer.name}/before/${slug}.html`
  );
  await fs.promises.writeFile(beforePath, beforeHtml);

  // Transform HTML.
  const transformContext = await createContext(browser);
  const args = await transformer.getArgs(transformContext, slug);
  await page.evaluate(transformer.transform, args);

  const afterHtml = await page.content();
  const afterPath = path.join(
    __dirname,
    `/pages/${transformer.name}/after/${slug}.html`
  );
  await fs.promises.writeFile(afterPath, afterHtml);
  await context.close();

  return {
    before: {
      path: beforePath,
    },
    after: {
      path: afterPath,
    },
  };
}

(async () => {
  // Setup
  const clArguments = process.argv;
  const transform = clArguments[2] || "addSrcSet";
  const browser = await chromium.launch();
  const transformer = transforms[transform];
  if (!transformer) {
    throw new Error(
      `Unknown transform name. Available transforms are ${Object.keys(
        transforms
      ).join(",")}`
    );
  }
  const transformerName = transformer.name;
  fsExtra.emptyDirSync(
    path.join(__dirname, `/pages/${transformerName}/before`)
  );
  fsExtra.emptyDirSync(path.join(__dirname, `/pages/${transformerName}/after`));

  const stats = [];
  let queue = topViews.slice(0, ARTICLE_COUNT);

  console.log(
    `Visiting ${queue.length} pages with transform ${transformerName}...`
  );
  while (queue.length) {
    const views = queue.splice(0, BATCH_SIZE);

    const promises = views.map(async (view) => {
      // @ts-ignore
      const slug = slugify(view.article, "_");

      // Create two versions of the same page.
      const paths = await createVersions(
        browser,
        slug,
        transformer,
        "https://en.m.wikipedia.org"
      );

      const beforeStats = await visitPage(
        browser,
        `file:///${paths.before.path}`,
        slug,
        `${transformer.name}/before`
      );
      const afterStats = await visitPage(
        browser,
        `file:///${paths.after.path}`,
        slug,
        `${transformer.name}/after`
      );

      stats.push({
        page: slug,

        // Image transfer size
        // beforeImageTransferSize: beforeStats.imageTransferSize,
        // afterImageTransferSize: afterStats.imageTransferSize,
        // diffImageTransferSize:
        //   afterStats.imageTransferSize - beforeStats.imageTransferSize,

        // Html size to the end of the first paragraph
        beforeHtmlSizeParagraph: beforeStats.htmlSizeParagraph,
        afterHtmlSizeParagraph: afterStats.htmlSizeParagraph,
        diffHtmlSizeParagraph:
          afterStats.htmlSizeParagraph - beforeStats.htmlSizeParagraph,

        // Html transfer size to the end of the first paragraph
        beforeHtmlTransferSizeParagraph: beforeStats.htmlTransferSizeParagraph,
        afterHtmlTransferSizeParagraph: afterStats.htmlTransferSizeParagraph,
        diffHtmlTransferSizeParagraph:
          afterStats.htmlTransferSizeParagraph -
          beforeStats.htmlTransferSizeParagraph,

        // Html size
        beforeHtmlSize: beforeStats.htmlSize,
        afterHtmlSize: afterStats.htmlSize,
        diffHtmlSize: afterStats.htmlSize - beforeStats.htmlSize,

        // Html transfer size
        beforeHtmlTransferSize: beforeStats.htmlTransferSize,
        afterHtmlTransferSize: afterStats.htmlTransferSize,
        diffHtmlTransferSize:
          afterStats.htmlTransferSize - beforeStats.htmlTransferSize,
      });
    });

    await Promise.all(promises);
  }

  // Sort by html transfer size.
  stats.sort((a, b) => {
    if (a.diffHtmlTransferSize < b.diffHtmlTransferSize) {
      // a is less than b.
      return -1;
    }

    if (a.diffHtmlTransferSize > b.diffHtmlTransferSize) {
      // b is less than a.
      return 1;
    }

    // a === b.
    return 0;
  });

  const statsFormatted = tablemark(
    stats.map((stat) => {
      return Object.keys(stat).reduce((accum, key) => {
        if (key === "page") {
          accum[key] = stat[key];

          return accum;
        }

        accum[key] = filesize(stat[key]);

        return accum;
      }, {});
    })
  );

  const diffHtmlSize = stats.map((stat) => stat.diffHtmlSize);
  const diffHtmlTransferSize = stats.map((stat) => stat.diffHtmlTransferSize);
  const diffImageTransferSize = stats.map((stat) => stat.diffImageTransferSize);
  const diffHtmlSizeParagraph = stats.map((stat) => stat.diffHtmlSizeParagraph);
  const diffHtmlTransferSizeParagraph = stats.map(
    (stat) => stat.diffHtmlTransferSizeParagraph
  );

  console.log(diffHtmlTransferSizeParagraph);
  const aggregate = tablemark([
    {
      // medianDiffImageTransferSize: filesize(median(diffImageTransferSize)),
      // maxDiffImageTransferSize: filesize(max(diffImageTransferSize)),

      medianDiffHtmlSizeParagraph: filesize(median(diffHtmlSizeParagraph)),
      maxDiffHtmlSizeParagraph: filesize(max(diffHtmlSizeParagraph)),

      medianDiffHtmlTransferSizeParagraph: filesize(
        median(diffHtmlTransferSizeParagraph)
      ),
      maxDiffHtmlTransferSizeParagraph: filesize(
        max(diffHtmlTransferSizeParagraph)
      ),

      medianDiffHtmlSize: filesize(median(diffHtmlSize)),
      maxDiffHtmlSize: filesize(max(diffHtmlSize)),

      medianDiffHtmlTransferSize: filesize(median(diffHtmlTransferSize)),
      maxDiffHtmlTransferDiff: filesize(max(diffHtmlTransferSize)),
    },
  ]);

  await fs.promises.writeFile(
    path.join(__dirname, "output.md"),
    statsFormatted + "\n\n" + aggregate
  );

  console.log(statsFormatted);
  console.log(aggregate);

  // Teardown
  await browser.close();
})();
