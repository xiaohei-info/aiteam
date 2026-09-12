import { inflateRawSync, inflateSync } from "node:zlib";
import type { LocalFileRecord } from "../storage/sqlite.js";

export const MAX_DOCUMENT_TEXT_CHARS = 64_000;
export const MAX_DOCUMENT_TOTAL_CHARS = 200_000;
export const MAX_DOCUMENT_PAGES = 50;
export const MAX_DOCX_ENTRIES = 128;
export const MAX_DOCX_UNCOMPRESSED_BYTES = 8 * 1024 * 1024;

export class UnsupportedDocumentError extends Error {
  constructor(message = "Attachment format is not supported as model input") { super(message); this.name = "UnsupportedDocumentError"; }
}

export interface ExtractedDocument {
  text: string;
  format: "text" | "pdf" | "docx";
}

export function extractDocument(record: Pick<LocalFileRecord, "filename" | "mime_type" | "byte_size">, data: Buffer): ExtractedDocument {
  if (data.byteLength !== record.byte_size || data.byteLength > 5 * 1024 * 1024) throw new UnsupportedDocumentError("Attachment exceeds the materialization limit");
  const mime = record.mime_type.toLowerCase();
  if (mime === "text/plain" || mime === "text/markdown" || mime === "text/csv" || mime === "application/json" || mime === "application/xml" || mime === "application/yaml") {
    return { text: boundedUtf8(data), format: "text" };
  }
  if (mime === "application/pdf") return { text: extractPdf(data), format: "pdf" };
  if (mime === "application/vnd.openxmlformats-officedocument.wordprocessingml.document") return { text: extractDocx(data), format: "docx" };
  throw new UnsupportedDocumentError(`Attachment ${record.filename} is storage-only and cannot be read by Pi`);
}

function boundedUtf8(data: Buffer): string {
  if (data.includes(0)) throw new UnsupportedDocumentError("Binary content is not supported as text input");
  const text = new TextDecoder("utf-8", { fatal: true }).decode(data).replace(/\r\n?/gu, "\n");
  if (!text.trim()) throw new UnsupportedDocumentError("Attachment has no readable text");
  return text.length <= MAX_DOCUMENT_TEXT_CHARS ? text : `${text.slice(0, MAX_DOCUMENT_TEXT_CHARS - 1)}…`;
}

function extractPdf(data: Buffer): string {
  if (!data.subarray(0, 5).equals(Buffer.from("%PDF-"))) throw new UnsupportedDocumentError("PDF signature does not match its MIME type");
  const source = data.toString("latin1");
  const pages = (source.match(/\/Type\s*\/Page(?:\s|\/)/gu) ?? []).length;
  if (pages > MAX_DOCUMENT_PAGES) throw new UnsupportedDocumentError("PDF has too many pages");
  const chunks: string[] = [];
  // Ordinary PDF text operators are supported. Small FlateDecode content
  // streams are also expanded locally; scanned/image PDFs and other encodings
  // remain OCR-unsupported.
  collectPdfStrings(source, chunks);
  const streams = /<<(?:[^>]|>(?!>))*>>\s*stream\r?\n([\s\S]*?)\r?\nendstream/gu;
  for (const match of source.matchAll(streams)) {
    const dictionary = match[0].slice(0, match[0].indexOf("stream"));
    if (!/\/FlateDecode(?:\s|\/|>)/u.test(dictionary) || !match[1]) continue;
    try {
      const encoded = Buffer.from(match[1], "latin1");
      const decoded = inflateSync(encoded, { maxOutputLength: 8 * 1024 * 1024 }).toString("latin1");
      collectPdfStrings(decoded, chunks);
    } catch {
      // Unsupported/corrupt streams are not text evidence.
    }
  }
  const text = chunks.join(" ").replace(/\s+/gu, " ").trim();
  if (!text) throw new UnsupportedDocumentError("Scanned PDF/OCR input is not supported");
  return text.length <= MAX_DOCUMENT_TEXT_CHARS ? text : `${text.slice(0, MAX_DOCUMENT_TEXT_CHARS - 1)}…`;
}

function collectPdfStrings(source: string, chunks: string[]): void {
  const strings = /\((?:\\.|[^\\)])*\)|<([0-9a-fA-F\s]+)>/gu;
  for (const match of source.matchAll(strings)) {
    const token = match[0];
    if (token.startsWith("<") && match[1]) {
      const hex = match[1].replace(/\s/gu, "");
      if (hex.length % 2 === 0) chunks.push(Buffer.from(hex, "hex").toString("latin1"));
    } else if (token.startsWith("(")) chunks.push(decodePdfLiteral(token.slice(1, -1)));
  }
}

function decodePdfLiteral(value: string): string {
  return value.replace(/\\([nrtbf()\\])/gu, (_all, escaped: string) => ({ n: "\n", r: "\r", t: "\t", b: "\b", f: "\f", "(": "(", ")": ")", "\\": "\\" }[escaped] ?? escaped)).replace(/\\([0-7]{1,3})/gu, (_all, octal: string) => String.fromCharCode(Number.parseInt(octal, 8)));
}

function extractDocx(data: Buffer): string {
  if (!data.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))) throw new UnsupportedDocumentError("DOCX ZIP signature does not match its MIME type");
  const documentXml = readZipEntry(data, "word/document.xml");
  if (!documentXml) throw new UnsupportedDocumentError("DOCX document body is missing");
  const text = documentXml
    .replace(/<w:tab\s*\/?>(?=.)/gu, "\t")
    .replace(/<w:br\s*\/?>(?=.)/gu, "\n")
    .replace(/<w:p(?:\s[^>]*)?>/gu, "\n")
    .replace(/<[^>]+>/gu, "")
    .replace(/&amp;/gu, "&").replace(/&lt;/gu, "<").replace(/&gt;/gu, ">").replace(/&quot;/gu, '"').replace(/&apos;/gu, "'")
    .replace(/\n{3,}/gu, "\n\n").trim();
  if (!text) throw new UnsupportedDocumentError("DOCX has no readable text");
  return text.length <= MAX_DOCUMENT_TEXT_CHARS ? text : `${text.slice(0, MAX_DOCUMENT_TEXT_CHARS - 1)}…`;
}

function readZipEntry(data: Buffer, wanted: string): string | undefined {
  let offset = 0;
  let entries = 0;
  let totalUncompressed = 0;
  while (offset + 30 <= data.length) {
    const signature = data.readUInt32LE(offset);
    if (signature === 0x04034b50) {
      entries += 1;
      if (entries > MAX_DOCX_ENTRIES) throw new UnsupportedDocumentError("DOCX has too many ZIP entries");
      const flags = data.readUInt16LE(offset + 6);
      const method = data.readUInt16LE(offset + 8);
      const compressedSize = data.readUInt32LE(offset + 18);
      const uncompressedSize = data.readUInt32LE(offset + 22);
      const nameLength = data.readUInt16LE(offset + 26);
      const extraLength = data.readUInt16LE(offset + 28);
      const name = data.subarray(offset + 30, offset + 30 + nameLength).toString("utf8");
      if (flags & 0x08) throw new UnsupportedDocumentError("DOCX data descriptors are unsupported");
      if (name.includes("..") || name.startsWith("/") || name.includes("\\")) throw new UnsupportedDocumentError("DOCX contains an unsafe path");
      totalUncompressed += uncompressedSize;
      if (totalUncompressed > MAX_DOCX_UNCOMPRESSED_BYTES) throw new UnsupportedDocumentError("DOCX expands beyond the materialization limit");
      const start = offset + 30 + nameLength + extraLength;
      const end = start + compressedSize;
      if (end > data.length || compressedSize === 0 && uncompressedSize > 0) throw new UnsupportedDocumentError("DOCX ZIP entry is malformed");
      if (name === wanted) {
        const raw = method === 0 ? data.subarray(start, end) : method === 8 ? inflateRawSync(data.subarray(start, end), { maxOutputLength: MAX_DOCX_UNCOMPRESSED_BYTES }) : undefined;
        if (!raw) throw new UnsupportedDocumentError("DOCX compression method is unsupported");
        if (raw.byteLength > MAX_DOCX_UNCOMPRESSED_BYTES) throw new UnsupportedDocumentError("DOCX entry is too large");
        return raw.toString("utf8");
      }
      offset = end;
      continue;
    }
    // Central directory/end records mark the end of local entries.
    if (signature === 0x02014b50 || signature === 0x06054b50) break;
    throw new UnsupportedDocumentError("DOCX ZIP structure is malformed");
  }
  return undefined;
}
