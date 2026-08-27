import { Sequelize } from "sequelize";
import { settings } from "../config.js";
import { logger } from "../logger.js";

export const sequelize = new Sequelize(settings.databaseUrl, {
  dialect: "mysql",
  logging: false,
  timezone: "+00:00",
});

export async function connectDb() {
  await sequelize.authenticate();
  logger.info("Connected to MySQL.");
}
