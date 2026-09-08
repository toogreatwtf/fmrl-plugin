import path from "node:path";

export type Format = "html" | "md";

export const ACCEPTED_EXTENSIONS = [".html", ".htm", ".md", ".markdown", ".mdx", ".txt"] as const;
export const MAX_BYTES = 2 * 1024 * 1024;
export const TOO_LARGE_MESSAGE = "That's bigger than the 2 MiB limit.";

const BY_EXTENSION: Record<string, Format> = {
  ".html": "html",
  ".htm": "html",
  ".md": "md",
  ".markdown": "md",
  ".mdx": "md",
  ".txt": "md",
};

/** formatForPath maps a file's extension to the format hint, or throws naming the accepted extensions. */
export function formatForPath(p: string): Format {
  const base = p.split(/[\\/]/).pop() ?? "";
  const ext = path.extname(base).toLowerCase();
  const format = ext === "" ? undefined : BY_EXTENSION[ext];
  if (!format) {
    throw new Error(`fmrl_publish_file accepts ${ACCEPTED_EXTENSIONS.join(", ")} files; ${base || p} is not one. Use fmrl_publish with the content instead.`);
  }
  return format;
}
