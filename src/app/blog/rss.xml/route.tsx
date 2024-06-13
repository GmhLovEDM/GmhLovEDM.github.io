import { NextResponse } from "next/server";
import { Feed } from "feed";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import rehypeStringify from "rehype-stringify";
import { fetchOrderedPosts } from "@/server/post";

export const dynamic = "force-static";

export async function GET() {
  const feed = new Feed({
    title: "GmhLovEDM's Blog",
    description: "Blog posts from GmhLovEDM with ❤️",
    id: "https://GmhLovEDM.app/blog",
    link: "https://GmhLovEDM.app/blog",
    image: "https://GmhLovEDM.app/twitter-cards/common.png",
    favicon: "https://GmhLovEDM.app/favicon.ico",
    copyright: "All rights reserved 2023, GmhLovEDM",
  });

  const posts = await fetchOrderedPosts();

  for (const post of posts) {
    const metadata = post.metadata;
    const link = `https://GmhLovEDM.app/blog/${post.slug}`;

    const html = await unified()
      .use(remarkParse)
      .use(remarkRehype)
      .use(rehypeStringify)
      .process(post.contents);

    feed.addItem({
      title: metadata.title,
      id: link,
      link,
      description: metadata.description,
      date: new Date(metadata.date),
      content: String(html),
    });
  }

  return new NextResponse(feed.rss2(), {
    headers: {
      "Content-Disposition": 'inline; filename="rss.xml"',
      "Content-Type": "application/xml",
    },
  });
}
