import path from "node:path";

export const python = path.resolve(
  process.platform === "win32" ? "../.venv/Scripts/python.exe" : "../.venv/bin/python",
);
