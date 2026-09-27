import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const fixturePath = path.join(ROOT, "fixtures/geometry/majdataplay-850f3e3e-representative.json");
const fixture = JSON.parse(await readFile(fixturePath, "utf8"));
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const gitBlobSha1 = (bytes) => createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");

test("the fixed Prefabs keep strip, motion-point, and connection-weight counts distinct", () => {
  assert.equal(fixture.evidence.playerBehaviorConfirmed, false);
  assert.equal(fixture.source.commit, "850f3e3eac354d328b1e9e8bde50b64c4946faf5");
  assert.deepEqual(
    fixture.slides.map(({ id, counts }) => [id, counts.visualStrips, counts.motionPathPoints, counts.connectionWeight]),
    [
      ["line3", 13, 15, 14],
      ["circle3", 15, 17, 16],
    ],
  );
  for (const slide of fixture.slides) {
    assert.equal(slide.motionPath.points.length, slide.counts.motionPathPoints);
    assert.equal(slide.visualStrips.length, slide.counts.visualStrips);
    assert.equal(slide.counts.prefabRootDirectChildren, slide.counts.connectionWeight);
    assert.equal(slide.terminalSlideOK.isSlideOK, true);
  }
});

test("Wi-Fi retains three independent motion tracks and no connection weight", () => {
  assert.equal(fixture.wifi.motionPaths.length, 3);
  assert.equal(fixture.wifi.durationWeights.connectionGroupWeight, null);
  assert.equal(fixture.wifi.counts.connectionWeight, null);
  assert.deepEqual(fixture.wifi.motionPaths.map((track) => track.endPosition), [4, 5, 6]);
  assert.equal(fixture.wifi.motionPaths.every((track) => track.interpolation === "Vector3.Lerp(start, end, process)"), true);
});

test("every recorded source and the generator still match the emitted hashes", async () => {
  for (const source of fixture.source.files) {
    const bytes = await readFile(path.join(ROOT, "vendor/MajdataPlay-geometry", source.path));
    assert.equal(gitBlobSha1(bytes), source.gitBlobSha1, source.path);
    assert.equal(sha256(bytes), source.sha256, source.path);
  }
  const generator = await readFile(path.join(ROOT, fixture.generator.path));
  assert.equal(sha256(generator), fixture.generator.sha256);
});
