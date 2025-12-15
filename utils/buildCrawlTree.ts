import type { CrawlResultItem, CrawlTreeNode } from "../types/crawl";

export function buildCrawlTree(
  results: CrawlResultItem[]
): CrawlTreeNode | null {
  const nodeMap = new Map<string, CrawlTreeNode>();
  let root: CrawlTreeNode | null = null;

  // 1) สร้าง node ทุกตัว
  for (const r of results) {
    nodeMap.set(r.url, {
      url: r.url,
      status: r.status,
      depth: r.depth,
      error: r.error,
      children: [],
    });
  }

  // 2) ผูก parent → child
  for (const r of results) {
    const node = nodeMap.get(r.url)!;

    if (!r.from) {
      root = node;
    } else {
      const parent = nodeMap.get(r.from);
      if (parent) {
        parent.children.push(node);
      }
    }
  }

  return root;
}
