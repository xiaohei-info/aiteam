import assert from "node:assert/strict";
import { test } from "node:test";
import { extractDocument, UnsupportedDocumentError } from "./document-extractor.js";

function record(filename: string, mime_type: string, byte_size: number) { return { filename, mime_type, byte_size }; }

function simpleStoredDocx(text: string): Buffer {
  const name = Buffer.from("word/document.xml");
  const body = Buffer.from(`<w:document><w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>`);
  const header = Buffer.alloc(30);
  header.writeUInt32LE(0x04034b50, 0);
  header.writeUInt16LE(20, 4);
  header.writeUInt16LE(0, 6);
  header.writeUInt16LE(0, 8);
  header.writeUInt32LE(body.length, 18);
  header.writeUInt32LE(body.length, 22);
  header.writeUInt16LE(name.length, 26);
  return Buffer.concat([header, name, body]);
}

test("document materialization extracts bounded UTF-8 text, ordinary PDF text, and DOCX text", () => {
  const text = Buffer.from("hello\nworld", "utf8");
  assert.equal(extractDocument(record("notes.md", "text/markdown", text.length), text).text, "hello\nworld");
  const pdf = Buffer.from("%PDF-1.7\n1 0 obj (PDF body)\nendobj\n%%EOF", "latin1");
  assert.equal(extractDocument(record("notes.pdf", "application/pdf", pdf.length), pdf).text, "PDF body");
  const docx = simpleStoredDocx("DOCX body");
  assert.equal(extractDocument(record("notes.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", docx.length), docx).text, "DOCX body");
});

test("scanned PDFs, binary text, and MIME/signature mismatches fail closed", () => {
  const scanned = Buffer.from("%PDF-1.7\n/Type /Page\n/Image\n%%EOF", "latin1");
  assert.throws(() => extractDocument(record("scan.pdf", "application/pdf", scanned.length), scanned), UnsupportedDocumentError);
  const binary = Buffer.from([0x00, 0x01, 0x02]);
  assert.throws(() => extractDocument(record("binary.txt", "text/plain", binary.length), binary), UnsupportedDocumentError);
  const malformed = Buffer.from("not a pdf", "utf8");
  assert.throws(() => extractDocument(record("bad.pdf", "application/pdf", malformed.length), malformed), /signature/);
});
