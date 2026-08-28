
import express from "express";
import session from "express-session";
import MySQLStoreFactory from "express-mysql-session";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { settings } from "./config.js";
import { logger } from "./logger.js";
import { connectDb, sequelize } from "./db/sequelize.js";
import { syncModels } from "./db/models.js";
import { getSessionSecret } from "./security/sessionSecret.js";
import { ensureDefaultAdmin } from "./admin/bootstrap.js";
import { router as adminApiRouter } from "./admin/apiRoutes.js";
import { router as adminUiRouter } from "./admin/uiRoutes.js";
import { whatsappClient, connectionState } from "./whatsapp/baileysClient.js";
import { createIngestHandler, handleDeliveryError } from "./whatsapp/ingest.js";
import { ConversationManager } from "./conversation/manager.js";
import { createPaymentsWebhookRouter } from "./payments/webhookRoutes.js";
import { startScheduler } from "./scheduler.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function main() {
  await connectDb();
  if (settings.environment === "development") {
    // Dev convenience only — real deployments should use proper migrations.
    await syncModels();
  }
  await ensureDefaultAdmin();

  const app = express();
  app.set("views", path.join(__dirname, "views"));
  app.set("view engine", "ejs");

  // conversationManager is needed by the payments webhook (to resume a gated flow once a
  // payment clears), so it's built before the app rather than down by whatsappClient.start().
  const conversationManager = new ConversationManager({ whatsappClient });

  // Mounted BEFORE express.json() — Paystack signs the raw body, so this route parses its
  // own body with express.raw() and must never have express.json() consume it first.
  app.use("/webhooks", createPaymentsWebhookRouter({ conversationManager }));

  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));
  // Public marketing site (src/public/index.html) at the site root — `extensions: ["html"]`
  // lets footer links like /privacy and /terms resolve to privacy.html/terms.html.
  app.use(express.static(path.join(__dirname, "public"), { extensions: ["html"] }));
  // ...and the same assets again under /admin/static for the dashboard's own pages.
  app.use("/admin/static", express.static(path.join(__dirname, "public")));

  const dbUrl = new URL(settings.databaseUrl);
  const MySQLStore = MySQLStoreFactory(session);
  const sessionStore = new MySQLStore({
    host: dbUrl.hostname,
    port: Number(dbUrl.port || 3306),
    user: decodeURIComponent(dbUrl.username),
    password: decodeURIComponent(dbUrl.password),
    database: dbUrl.pathname.replace(/^\//, ""),
  });

  app.use(
    session({
      key: "migratech_admin_session",
      secret: getSessionSecret(),
      store: sessionStore,
      resave: false,
      saveUninitialized: false,
      cookie: {
        maxAge: 12 * 60 * 60 * 1000,
        secure: settings.environment !== "development",
        httpOnly: true,
      },
    })
  );

  app.use("/admin/api", adminApiRouter);
  app.use("/admin", adminUiRouter);

  app.get("/health", (req, res) => {
    res.json({
      status: "ok",
      whatsapp_status: connectionState.status,
      ai_configured: settings.aiConfigured,
    });
  });

  const handleIncomingMessage = createIngestHandler({ whatsappClient, conversationManager });
  await whatsappClient.start(handleIncomingMessage, handleDeliveryError);

  const scheduledTasks = startScheduler(whatsappClient);

  const server = app.listen(settings.port, () => {
    logger.info(`MigraTech listening on http://localhost:${settings.port}`);
  });

  const shutdown = async () => {
    logger.info("Shutting down...");
    for (const task of scheduledTasks) task.stop();
    server.close();
    await sequelize.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  logger.error({ err }, "Fatal startup error");
  process.exit(1);
});
