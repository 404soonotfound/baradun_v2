import path from "node:path";
import beachMeta from "../../../data/beach-meta.json";
import { loadBeaches } from "../core/beaches/load";
import type { InquirySummary } from "./inquiries";
import { payloadHashOf } from "./writes";

const NO_BEACH = "__none__";
const UTC_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const MAX_SEARCH_LENGTH = 100;
const PREVIEW_LENGTH = 42;

export interface InquiryFilters {
  readonly q?: string;
  readonly type?: string;
  readonly beachId?: string;
  readonly from?: string;
  readonly to?: string;
  readonly preview?: true;
}

function utcInstant(value: string | undefined): string | undefined {
  if (value === undefined || !UTC_INSTANT.test(value)) return undefined;
  const canonical = value.length === 20 ? value.replace("Z", ".000Z") : value;
  const date = new Date(canonical);
  return Number.isFinite(date.getTime()) && date.toISOString() === canonical
    ? canonical
    : undefined;
}

function normalized(value: string): string {
  return value.normalize("NFC").toLowerCase();
}

export function parseInquiryFilters(
  params: Readonly<Record<string, string | undefined>>,
): { filters: InquiryFilters } | { invalid: string } {
  const { q, type, beachId, from, to, preview } = params;
  if (q !== undefined && [...q].length > MAX_SEARCH_LENGTH) {
    return { invalid: "q" };
  }
  if (type !== undefined && !/^[a-z][a-z0-9_]{0,63}$/.test(type)) {
    return { invalid: "type" };
  }
  if (
    beachId !== undefined &&
    beachId !== NO_BEACH &&
    !/^b\d{4}$/.test(beachId)
  ) {
    return { invalid: "beachId" };
  }
  const start = utcInstant(from);
  const end = utcInstant(to);
  if (from !== undefined && start === undefined) return { invalid: "from" };
  if (
    to !== undefined &&
    (end === undefined || (start !== undefined && start > end))
  ) {
    return { invalid: "to" };
  }
  if (preview !== undefined && preview !== "true")
    return { invalid: "preview" };
  const search = q?.trim();
  return {
    filters: {
      ...(search ? { q: normalized(search) } : {}),
      ...(type !== undefined ? { type } : {}),
      ...(beachId !== undefined ? { beachId } : {}),
      ...(start ? { from: start } : {}),
      ...(end ? { to: end } : {}),
      ...(preview === "true" ? { preview: true } : {}),
    },
  };
}

export function inquiryFilterScope(
  filters: InquiryFilters,
  status: string | undefined,
  audience: "sample" | "viewer" | "operator",
): string | undefined {
  // 검색어를 cursor에 평문으로 넣지 않음
  return Object.keys(filters).length
    ? payloadHashOf(JSON.stringify([filters, status, audience]))
    : undefined;
}

type BeachSearch = (id: string, query: string) => boolean;

export function createInquiryBeachSearch(directory: string): BeachSearch {
  const meta: Readonly<
    Record<string, { readonly aliases?: readonly string[] }>
  > = beachMeta.beaches;
  const names = new Map(
    loadBeaches(directory).map(({ id, name }) => [
      id,
      [name.ko, name.en, ...(meta[id]?.aliases ?? [])].map(normalized),
    ]),
  );
  return (id, query) =>
    normalized(id).includes(query) ||
    (names.get(id)?.some((name) => name.includes(query)) ?? false);
}

let beachSearch: BeachSearch | undefined;
export function matchesInquiryBeach(id: string, query: string): boolean {
  beachSearch ??= createInquiryBeachSearch(path.join(__dirname, "beaches"));
  return beachSearch(id, query);
}

export function matchesInquiryMetadata(
  item: InquirySummary,
  filters: InquiryFilters,
): boolean {
  return (
    (filters.type === undefined || item.type === filters.type) &&
    (filters.beachId === undefined ||
      (filters.beachId === NO_BEACH
        ? !item.beachId
        : item.beachId === filters.beachId)) &&
    (filters.from === undefined || item.receivedAt >= filters.from) &&
    (filters.to === undefined || item.receivedAt <= filters.to)
  );
}

export function matchesInquiryMessage(message: string, query: string): boolean {
  return normalized(message).includes(query);
}

export function withInquiryPreview(
  item: InquirySummary,
  message: string,
): InquirySummary {
  const clean = message.replace(/\s+/g, " ").trim();
  if (clean === "") return item;
  const chars = [...clean];
  return {
    ...item,
    messagePreview:
      chars.length <= PREVIEW_LENGTH
        ? clean
        : `${chars.slice(0, PREVIEW_LENGTH).join("").trimEnd()}…`,
  };
}
