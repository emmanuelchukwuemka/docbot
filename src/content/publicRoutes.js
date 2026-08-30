// Public-facing pages for admin-managed site content — /blog, /news, /guides. Three
// separate tables (see db/models.js) each get their own routes here; the *presentation*
// (portal/content_list.ejs, portal/content_detail.ejs) is shared since it's identical
// today — sharing a view template is a DRY convenience, not a data/system merge.

import { Router } from "express";
import { BlogPost, Guide, NewsPost } from "../db/models.js";

export const router = Router();

// Same reasoning as portal/routes.js's wrap() — an async route handler that throws would
// otherwise crash the whole process, not just 404/500 this one request.
function wrap(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

function serializeSummary(item) {
  return {
    title: item.title,
    slug: item.slug,
    excerpt: item.excerpt,
    author: item.author,
    cover_image_url: item.cover_image_url,
    published_at: item.published_at ? item.published_at.toISOString() : null,
  };
}

function registerContentRoutes(Model, basePath, pageLabel) {
  router.get(
    basePath,
    wrap(async (req, res) => {
      const items = await Model.findAll({
        where: { is_published: true },
        order: [["published_at", "DESC"]],
      });
      res.render("portal/content_list", {
        pageLabel,
        basePath,
        items: items.map(serializeSummary),
      });
    })
  );

  router.get(
    `${basePath}/:slug`,
    wrap(async (req, res) => {
      const item = await Model.findOne({ where: { slug: req.params.slug, is_published: true } });
      if (!item) return res.status(404).render("portal/content_list", { pageLabel, basePath, items: [], notFoundSlug: req.params.slug });
      res.render("portal/content_detail", {
        pageLabel,
        basePath,
        item: {
          title: item.title,
          body: item.body,
          author: item.author,
          cover_image_url: item.cover_image_url,
          published_at: item.published_at ? item.published_at.toISOString() : null,
        },
      });
    })
  );
}

registerContentRoutes(BlogPost, "/blog", "Blog");
registerContentRoutes(NewsPost, "/news", "News & Updates");
registerContentRoutes(Guide, "/guides", "Guides");

const STATIC_PAGES = ["/", "/privacy", "/terms", "/contact", "/countries", "/pathways", "/blog", "/news", "/guides"];

// Real, generated from actual published rows — not a static file, so a new blog post shows
// up here on its own the moment it's published, no manual sitemap maintenance.
router.get(
  "/sitemap.xml",
  wrap(async (req, res) => {
    const base = `${req.protocol}://${req.get("host")}`;
    const urls = [...STATIC_PAGES];
    for (const [Model, path] of [[BlogPost, "/blog"], [NewsPost, "/news"], [Guide, "/guides"]]) {
      const items = await Model.findAll({ where: { is_published: true }, attributes: ["slug"] });
      for (const item of items) urls.push(`${path}/${item.slug}`);
    }
    res.set("Content-Type", "application/xml");
    res.send(
      `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
        urls.map((u) => `  <url><loc>${base}${u}</loc></url>`).join("\n") +
        `\n</urlset>`
    );
  })
);

// Same generic fallback as portal/routes.js.
router.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  res
    .status(500)
    .send(
      '<!doctype html><html><body style="font-family:sans-serif;text-align:center;padding:80px 20px">' +
        "<h1>Something went wrong</h1><p>Please try again in a moment.</p>" +
        '<a href="/">Back to MigraTech</a></body></html>'
    );
});
