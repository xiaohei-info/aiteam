import type { SkillFile, SkillImportInput } from "./types.js";

const UPLOAD_SOURCES = new Set(["folder", "zip", "file", "editor"]);

/**
 * 导入 / 保存技能的请求体：上传来源与在线编辑用 multipart（文件 + 一一对应的相对路径），
 * 粘贴与网址用 JSON。`extra` 是各端自己的附加字段（如企业端的可见范围）。
 */
export function skillImportBody(input: SkillImportInput, extra: Record<string, string> = {}): FormData | Record<string, unknown> {
  if (!UPLOAD_SOURCES.has(input.source)) {
    const { files: _files, ...json } = input;
    return { ...json, ...extra };
  }
  const form = new FormData();
  form.append("source", input.source);
  for (const item of input.files ?? []) {
    form.append("files", item.file, item.file.name);
    form.append("paths", item.path);
  }
  for (const root of input.roots ?? []) form.append("roots", root);
  for (const [key, value] of Object.entries(extra)) form.append(key, value);
  return form;
}

/** 在线编辑的文件 → 「editor」来源的上传（与上传文件夹同一条路径，服务端同一套校验）。 */
export function editorInput(files: SkillFile[]): SkillImportInput {
  return {
    source: "editor",
    files: files.map((item) => ({
      file: new File([item.content], item.path.split("/").pop() || "file", { type: "text/plain" }),
      path: item.path,
    })),
  };
}
