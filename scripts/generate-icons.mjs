import { readFile } from "node:fs/promises";
import sharp from "sharp";

const source = await readFile("assets/icon-source.svg");

await Promise.all(
  [16, 32, 48, 128].map((size) =>
    sharp(source)
      .resize(size, size)
      .png()
      .toFile(`public/icon/icon-${size}.png`),
  ),
);
