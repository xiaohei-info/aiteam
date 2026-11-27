import assert from "node:assert/strict";
import { linkSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createFixture } from "../test-fixture.js";
import { attachmentManifest, parseAttachmentPaths, readAttachmentRef, resolveAttachmentPath } from "./attachment-refs.js";
import { credentialFolderForPath, projectPathPolicyForTests } from "./project-path-policy.js";

const owner = { conversationId: "c1", tenantId: "tenant-1", memberId: "member-1" };
const text = (result: { content: unknown[] }) => (result.content as Array<{ text?: string }>).map((part) => part.text ?? "").join("");

test("attachment_read pages text, notices edits, and reports moved or unreadable files", async () => {
  const fixture = await createFixture();
  const dir = mkdtempSync(join(tmpdir(), "attach-ref-"));
  try {
    const notes = join(dir, "notes.txt");
    writeFileSync(notes, "abcdefghij");
    const video = join(dir, "clip.mp4");
    writeFileSync(video, Buffer.alloc(16));
    const pages = Array.from({ length: 60 }, (_, index) => `<< /Type /Page >> (page ${index})`).join("\n");
    const pdf = join(dir, "long.pdf");
    writeFileSync(pdf, `%PDF-1.7\n${pages}\n%%EOF`, "latin1");
    const [notesRef, videoRef, pdfRef] = fixture.store.upsertLocalFileRefs(owner, [resolveAttachmentPath({ path: notes }), resolveAttachmentPath({ path: video }), resolveAttachmentPath({ path: pdf })]);
    assert(notesRef && videoRef && pdfRef);
    // The same path in one conversation keeps one ID.
    assert.equal(fixture.store.upsertLocalFileRefs(owner, [resolveAttachmentPath({ path: notes })])[0]!.id, notesRef.id);

    assert.equal(text(readAttachmentRef(fixture.store, owner, { attachment: notesRef.id, limit: 4 })).split("\n")[0], "abcd");
    assert.match(text(readAttachmentRef(fixture.store, owner, { attachment: "notes.txt", offset: 4 })), /^efghij\n\n\[已读到末尾/u);
    // More than the 50 pages an upload allows.
    assert.match(text(readAttachmentRef(fixture.store, owner, { attachment: pdfRef.id, limit: 64000 })), /page 59/u);
    assert.match(text(readAttachmentRef(fixture.store, owner, { attachment: videoRef.id })), /不支持读取内容/u);

    writeFileSync(notes, "changed!!!!!");
    utimesSync(notes, new Date(), new Date(Date.now() + 5000));
    assert.match(text(readAttachmentRef(fixture.store, owner, { attachment: notesRef.id })), /被修改过[\s\S]*changed/u);
    rmSync(notes);
    const gone = readAttachmentRef(fixture.store, owner, { attachment: notesRef.id });
    assert.equal((gone as { isError?: boolean }).isError, true);
    assert.match(text(gone), /已被移动或删除/u);
    // Another member, or a guessed ID, finds nothing.
    assert.match(text(readAttachmentRef(fixture.store, { ...owner, memberId: "member-2" }, { attachment: pdfRef.id })), /没有找到附件/u);

    const manifest = attachmentManifest([videoRef, pdfRef], new Set());
    assert.match(manifest, /clip\.mp4（视频，16 B，无法读取内容）/u);
    assert.equal(manifest.includes(dir), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    await fixture.close();
  }
});

test("attachment_paths accepts only absolute paths with plain names", () => {
  assert.deepEqual(parseAttachmentPaths(undefined), []);
  assert.deepEqual(parseAttachmentPaths([{ path: "/a/b.pdf", name: " 报告.pdf " }]), [{ path: "/a/b.pdf", name: "报告.pdf" }]);
  for (const bad of [[{ path: "b.pdf" }], [{ path: "/a", name: "x/y" }], [{ path: "/a", extra: 1 }], "nope", Array.from({ length: 9 }, () => ({ path: "/a" }))]) {
    assert.throws(() => parseAttachmentPaths(bad));
  }
});

// The path arrives from the renderer, so the Agent refuses credential folders itself. Library/AppData stay
// attachable: screenshots and app caches live there and the client lets the user attach those.
test("attachment paths inside a credential folder are refused, other folders are not", () => {
  const dir = mkdtempSync(join(tmpdir(), "attach-cred-"));
  try {
    mkdirSync(join(dir, ".ssh"));
    const key = join(dir, ".ssh", "id_rsa");
    writeFileSync(key, "PRIVATE");
    assert.throws(() => resolveAttachmentPath({ path: key }), (error: unknown) => {
      assert.equal((error as { code?: string }).code, "attachment_in_credential_folder");
      assert.match((error as Error).message, /凭据[\s\S]*\.ssh/u);
      return true;
    });

    mkdirSync(join(dir, "Library", "Caches"), { recursive: true });
    const shot = join(dir, "Library", "Caches", "shot.png");
    writeFileSync(shot, Buffer.alloc(4));
    assert.equal(resolveAttachmentPath({ path: shot }).name, "shot.png");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Multi-folder entries match as a whole: only `.config/gcloud` is the gcloud credential store.
test("a folder merely named like the last part of a credential entry is not a credential folder", () => {
  assert.equal(credentialFolderForPath("/Users/u/Documents/gcloud/账单.pdf", "/Users/u", "darwin"), undefined);
  assert.equal(credentialFolderForPath("/Users/u/gcloud/x.json", "/Users/u", "darwin"), undefined);
  assert.equal(credentialFolderForPath("/Users/u/.config/gcloud/credentials.db", "/Users/u", "darwin"), ".config/gcloud");
  assert.equal(credentialFolderForPath("/Volumes/backup/home/.config/gcloud/adc.json", "/Users/u", "darwin"), ".config/gcloud");
  assert.equal(credentialFolderForPath("/Users/u/.configs/gcloud/a.txt", "/Users/u", "darwin"), undefined);
  assert.equal(credentialFolderForPath("/Users/u/Projects/app/.ssh/id_rsa", "/Users/u", "darwin"), ".ssh");
  assert.equal(credentialFolderForPath("C:\\Users\\u\\Documents\\gcloud\\a.pdf", "C:\\Users\\u", "win32"), undefined);
  assert.equal(credentialFolderForPath("C:\\Users\\u\\.config\\gcloud\\a.json", "C:\\Users\\u", "win32"), ".config/gcloud");
});

// A hard link to a key carries no trace of the key in its own path, so realpath + the credential list
// cannot judge it: a file with more than one link is refused instead.
test("an attachment with more than one hard link is refused", () => {
  const dir = mkdtempSync(join(tmpdir(), "attach-link-"));
  try {
    mkdirSync(join(dir, ".ssh"));
    const key = join(dir, ".ssh", "id_rsa");
    writeFileSync(key, "PRIVATE");
    const disguised = join(dir, "report.pdf");
    linkSync(key, disguised);
    assert.throws(() => resolveAttachmentPath({ path: disguised }), (error: unknown) => {
      assert.equal((error as { code?: string }).code, "attachment_has_hard_links");
      return true;
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Registration is not the last check: the same file is judged again on every read.
test("attachment_read refuses a path that was swapped for a link after it was attached", async () => {
  const fixture = await createFixture();
  const dir = mkdtempSync(join(tmpdir(), "attach-swap-"));
  try {
    mkdirSync(join(dir, ".ssh"));
    const key = join(dir, ".ssh", "id_rsa");
    writeFileSync(key, "PRIVATE KEY");
    const plain = join(dir, "other.txt");
    writeFileSync(plain, "harmless");

    const swap = (target: string) => {
      const notes = join(dir, "notes.txt");
      writeFileSync(notes, "hello");
      const ref = fixture.store.upsertLocalFileRefs(owner, [resolveAttachmentPath({ path: notes })])[0]!;
      rmSync(notes);
      symlinkSync(target, notes);
      const result = readAttachmentRef(fixture.store, owner, { attachment: ref.id });
      rmSync(notes);
      return result;
    };

    const stolen = swap(key);
    assert.equal((stolen as { isError?: boolean }).isError, true);
    assert.match(text(stolen), /凭据/u);
    assert.equal(text(stolen).includes("PRIVATE KEY"), false);

    const elsewhere = swap(plain);
    assert.equal((elsewhere as { isError?: boolean }).isError, true);
    assert.match(text(elsewhere), /指向另一个文件/u);
    assert.equal(text(elsewhere).includes("harmless"), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    await fixture.close();
  }
});

// The name the client sends is a label; the type comes from the file on disk.
test("attachment type is taken from the real file, not from the name the client sent", () => {
  const dir = mkdtempSync(join(tmpdir(), "attach-mime-"));
  try {
    const file = join(dir, "notes.txt");
    writeFileSync(file, "plain");
    assert.equal(resolveAttachmentPath({ path: file, name: "报告.pdf" }).mime_type, "text/plain");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// One source of truth: the credential list is the subset of the project-folder policy that applies here.
test("credential_home_roots is the credential subset of home_roots", () => {
  const policy = projectPathPolicyForTests();
  for (const platform of [policy.macos, policy.windows]) {
    assert(platform.credential_home_roots && platform.credential_home_roots.length > 0);
    for (const root of platform.credential_home_roots) assert(platform.home_roots.includes(root), root);
  }
  assert.equal(policy.macos.credential_home_roots!.includes("Library"), false);
  assert.equal(policy.windows.credential_home_roots!.includes("AppData"), false);
});
