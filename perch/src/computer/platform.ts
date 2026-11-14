import type { Driver } from "./driver.js";
import { driver as darwin } from "./darwin.js";
import { available as darwinAvailable } from "./darwin.js";

// The perch currently ships a macOS driver; `win32` lands next and slots in here.
export const driver: Driver = darwin;
export const available = () => (process.platform === "darwin" ? darwinAvailable() : false);
