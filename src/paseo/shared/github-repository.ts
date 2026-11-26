import { repositorySlug } from "./prs";

export function githubRepository(remote: string | null | undefined): string | null {
  if (!remote || remote.length > 512) return null;
  const match = /^(?:https:\/\/github\.com\/|ssh:\/\/git@github\.com\/|git@github\.com:)([^/?#\s]+\/[^/?#\s]+?)\/?$/i.exec(remote.trim());
  if (!match) return null;
  const parsed = repositorySlug.safeParse(match[1].replace(/\.git$/i,""));
  return parsed.success ? parsed.data : null;
}
