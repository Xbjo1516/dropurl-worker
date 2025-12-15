// src/types/crawl.ts

export type CrawlResultItem = {
  url: string;
  status: number | null;
  depth: number;
  from: string | null;
  error: string | null;
};

export type CrawlTreeNode = {
  url: string;
  status: number | null;
  depth: number;
  error: string | null;
  children: CrawlTreeNode[];
};
