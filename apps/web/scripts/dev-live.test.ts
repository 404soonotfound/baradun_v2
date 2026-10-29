import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { hasDevSampleSnapshot } from "../src/lib/dev-sample";
import { DEV_DATA_MODE_FILE, clearDevData, writeDevData } from "./dev-data.mts";
import {
  mirrorLiveSnapshot,
  parseLiveOrigin,
  startLiveMirror,
} from "./dev-live.mts";

// 운영 CloudFront 대신 쓰는 로컬 서버. 계약 예시를 운영 snapshot처럼 /data/… 경로로 내보냄
const EXAMPLES = path.join(
  import.meta.dirname,
  "../../../packages/contracts/examples/valid",
);
const VERSION = "20261017T053000Z";

const temporaryRoots: string[] = [];
const servers: Server[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "baradun-dev-live-"));
  temporaryRoots.push(root);
  // 운영 버킷 모양: data/manifest.json + data/{version}/*.json
  const bucket = path.join(root, "bucket");
  mkdirSync(path.join(bucket, "data", VERSION), { recursive: true });
  for (const name of readdirSync(EXAMPLES)) {
    const target =
      name === "manifest.json"
        ? path.join(bucket, "data", name)
        : path.join(bucket, "data", VERSION, name);
    cpSync(path.join(EXAMPLES, name), target);
  }
  return { bucket, outDir: path.join(root, "public-data") };
}

interface Served {
  origin: string;
  requests: Array<{ url: string; headers: Record<string, unknown> }>;
}

async function serve(
  bucket: string,
  override?: (
    url: string,
  ) => { status: number; body?: string } | "hang" | undefined,
): Promise<Served> {
  const requests: Served["requests"] = [];
  const server = createServer((req, res) => {
    const url = req.url ?? "/";
    requests.push({ url, headers: { ...req.headers } });
    const custom = override?.(url);
    if (custom === "hang") return; // 응답하지 않음(시간 초과 재현)
    if (custom) {
      res.writeHead(custom.status).end(custom.body ?? "");
      return;
    }
    const file = path.join(bucket, url);
    if (!file.startsWith(bucket) || !existsSync(file)) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(readFileSync(file));
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { origin: `http://127.0.0.1:${port}`, requests };
}

const manifestAt = (outDir: string) =>
  JSON.parse(readFileSync(path.join(outDir, "manifest.json"), "utf8")) as {
    snapshotVersion: string;
  };

describe("운영 주소 검사", () => {
  it("https 도메인만 받고 끝의 / 는 정리함", () => {
    expect(parseLiveOrigin("https://d123.cloudfront.net/")).toBe(
      "https://d123.cloudfront.net",
    );
    expect(parseLiveOrigin("http://127.0.0.1:4100")).toBe(
      "http://127.0.0.1:4100",
    );
  });

  it.each([
    [undefined, /운영 CloudFront 주소/],
    ["", /운영 CloudFront 주소/],
    ["not a url", /주소 형식/],
    ["http://d123.cloudfront.net", /https/],
    ["https://user:pw@d123.cloudfront.net", /사용자 정보/],
    ["https://d123.cloudfront.net/?token=x", /사용자 정보/],
    ["https://d123.cloudfront.net/data", /경로 없이/],
  ])("%s → 거부", (value, message) => {
    expect(() => parseLiveOrigin(value)).toThrow(message);
  });
});

describe("운영 snapshot 미러", () => {
  it("manifest와 버전 파일을 받은 그대로 게시하고 live 표지를 남김", async () => {
    const { bucket, outDir } = fixture();
    const { origin, requests } = await serve(bucket);

    const result = await mirrorLiveSnapshot({ origin, outDir });

    expect(result).toEqual({ version: VERSION, changed: true });
    expect(readFileSync(path.join(outDir, "manifest.json"), "utf8")).toBe(
      readFileSync(path.join(bucket, "data/manifest.json"), "utf8"),
    );
    expect(
      readFileSync(path.join(outDir, VERSION, "status.json"), "utf8"),
    ).toBe(
      readFileSync(path.join(bucket, "data", VERSION, "status.json"), "utf8"),
    );
    expect(readFileSync(path.join(outDir, DEV_DATA_MODE_FILE), "utf8")).toBe(
      "live\n",
    );
    // 공개 정적 파일만 읽음: 인증·쿠키 헤더를 보내지 않음
    for (const { headers } of requests) {
      expect(headers.authorization).toBeUndefined();
      expect(headers.cookie).toBeUndefined();
    }
  });

  it("운영 데이터는 '개발용 예시' 안내 대상이 아님", async () => {
    const { bucket, outDir } = fixture();
    const { origin } = await serve(bucket);
    await mirrorLiveSnapshot({ origin, outDir });
    expect(hasDevSampleSnapshot(outDir)).toBe(false);

    clearDevData(outDir);
    writeDevData({ outDir });
    expect(hasDevSampleSnapshot(outDir)).toBe(true);
  });

  it("같은 버전이면 manifest만 확인하고 파일을 다시 받지 않음", async () => {
    const { bucket, outDir } = fixture();
    const { origin, requests } = await serve(bucket);
    await mirrorLiveSnapshot({ origin, outDir });
    const before = requests.length;

    const result = await mirrorLiveSnapshot({ origin, outDir });

    expect(result.changed).toBe(false);
    expect(requests.slice(before).map((r) => r.url)).toEqual([
      "/data/manifest.json",
    ]);
  });

  it("버전 경로 밖을 가리키는 manifest는 거부하고 아무것도 쓰지 않음", async () => {
    const { bucket, outDir } = fixture();
    const manifestFile = path.join(bucket, "data/manifest.json");
    const manifest = JSON.parse(readFileSync(manifestFile, "utf8"));
    manifest.files.status = `/data/${VERSION}/../../secret.json`;
    writeFileSync(manifestFile, JSON.stringify(manifest));
    const { origin } = await serve(bucket);

    await expect(mirrorLiveSnapshot({ origin, outDir })).rejects.toThrow(
      /파일 경로/,
    );
    expect(existsSync(outDir)).toBe(false);
  });

  it("버전 파일 하나라도 실패하면 이전 게시본을 그대로 둠", async () => {
    const { bucket, outDir } = fixture();
    const first = await serve(bucket);
    await mirrorLiveSnapshot({ origin: first.origin, outDir });
    const published = readFileSync(path.join(outDir, "manifest.json"), "utf8");

    // 운영이 새 버전을 냈지만 status를 받지 못함
    const next = "20261017T055000Z";
    const manifestFile = path.join(bucket, "data/manifest.json");
    const manifest = JSON.parse(readFileSync(manifestFile, "utf8"));
    manifest.snapshotVersion = next;
    for (const key of Object.keys(manifest.files)) {
      manifest.files[key] = manifest.files[key].replace(VERSION, next);
    }
    writeFileSync(manifestFile, JSON.stringify(manifest));
    cpSync(
      path.join(bucket, "data", VERSION),
      path.join(bucket, "data", next),
      {
        recursive: true,
      },
    );
    const second = await serve(bucket, (url) =>
      url.endsWith("status.json") ? { status: 503 } : undefined,
    );

    await expect(
      mirrorLiveSnapshot({ origin: second.origin, outDir }),
    ).rejects.toThrow(/503/);
    expect(readFileSync(path.join(outDir, "manifest.json"), "utf8")).toBe(
      published,
    );
    expect(existsSync(path.join(outDir, next))).toBe(false);
  });

  it("JSON이 아닌 응답과 시간 초과는 게시하지 않음", async () => {
    const { bucket, outDir } = fixture();
    const broken = await serve(bucket, (url) =>
      url.endsWith("history.json")
        ? { status: 200, body: "<html>" }
        : undefined,
    );
    await expect(
      mirrorLiveSnapshot({ origin: broken.origin, outDir }),
    ).rejects.toThrow();

    const hanging = await serve(bucket, () => "hang");
    await expect(
      mirrorLiveSnapshot({ origin: hanging.origin, outDir, timeoutMs: 200 }),
    ).rejects.toThrow();
    expect(existsSync(path.join(outDir, "manifest.json"))).toBe(false);
  });

  it("예시(sample)가 남긴 버전은 직전 버전으로 남기지 않음", async () => {
    const { bucket, outDir } = fixture();
    const sampleVersion = writeDevData({ outDir });
    const { origin } = await serve(bucket);

    await mirrorLiveSnapshot({ origin, outDir });

    expect(existsSync(path.join(outDir, sampleVersion))).toBe(false);
    expect(manifestAt(outDir).snapshotVersion).toBe(VERSION);
  });
});

describe("운영 snapshot 주기 확인", () => {
  it("실패해도 멈추지 않고 다음 확인에서 게시함", async () => {
    const { bucket, outDir } = fixture();
    let down = true;
    const { origin } = await serve(bucket, () =>
      down ? { status: 503 } : undefined,
    );
    const errors: unknown[] = [];
    const published: string[] = [];

    const stop = startLiveMirror({
      origin,
      outDir,
      intervalMs: 50,
      onError: (error) => errors.push(error),
      onPublished: (version) => published.push(version),
    });
    await expect.poll(() => errors.length).toBeGreaterThan(0);
    down = false;
    await expect.poll(() => published).toEqual([VERSION]);
    stop();
  });

  it("멈춘 뒤 늦게 끝난 요청은 public/data에 쓰지 않음", async () => {
    const { bucket, outDir } = fixture();
    const { origin } = await serve(bucket);
    let release = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    let requested = 0;
    // 첫 요청(manifest)을 붙잡아 두고 그동안 멈춤
    const fetchImpl: typeof fetch = async (input, init) => {
      requested += 1;
      await gate;
      return fetch(input, init);
    };
    const errors: unknown[] = [];

    const stop = startLiveMirror({
      origin,
      outDir,
      fetchImpl,
      onError: (error) => errors.push(error),
    });
    await expect.poll(() => requested).toBeGreaterThan(0);
    stop();
    release();
    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(existsSync(outDir)).toBe(false);
    expect(errors).toEqual([]);
  });
});
