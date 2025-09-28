import pino from "pino";
import { cfg } from "./config.js";
export const log = pino({ level: cfg.logLevel });


