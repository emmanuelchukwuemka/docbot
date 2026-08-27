import pino from "pino";
import { settings } from "./config.js";

export const logger = pino(
  settings.environment === "development"
    ? { level: settings.logLevel, transport: { target: "pino-pretty", options: { colorize: true } } }
    : { level: settings.logLevel }
);
