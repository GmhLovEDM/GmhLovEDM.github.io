import { FC } from "react";
import { PostMetadata } from "@/server/post";
import { formatTimestampToHumanReadableDate } from "@/utils/date-fns";
import { LangSwitcherInteraction } from "./LangSwitcherInteraction";
import { MarkdownReader } from "./MarkdownReader";

const ShareButton: FC<{
  children: string;
  url: string;
  params?: Record<string, string>;
}> = ({ children, url, params }) => {
  const urlBuilder = new URL(url);
  for (const paramKey in params) {
    urlBuilder.searchParams.append(paramKey, params[paramKey]);
  }

  return (
    <a
      className="text-foreground underline decoration-transparent hover:decoration-foreground transition-colors duration-200"
      href={urlBuilder.toString()}
      target="_blank"
    >
      {children}
    </a>
  );
};

type BlogPostProps = {
  contents: string;
  metadata: PostMetadata;
  shareUrl: string;
  availableTranslations: string[];
  lang?: string;
};

export function BlogPost(props: BlogPostProps) {
  const {
    contents,
    metadata: { slug, title, tag, date, description },
    shareUrl,
    availableTranslations,
    lang,
  } = props;

  // TODO: do we need to add supports for other languages?
  const hasChineseVersion = availableTranslations.includes("zh_CN");
  const isChineseVersion = lang === "zh_CN";

  return (
    <>
      <article>
        <header>
          {hasChineseVersion ? (
            <LangSwitcherInteraction
              slug={slug}
              translationEnabled={isChineseVersion}
            />
          ) : null}
          <p className="text-foreground-tertiary mb-2">
            #{tag} / <time>{formatTimestampToHumanReadableDate(date)}</time>
          </p>
          <h1 className="mb-4 text-3xl md:text-5xl md:leading-tight font-bold">
            {title}
          </h1>
          <h2 className="text-lg md:text-xl font-light text-foreground-secondary">
            {description}
          </h2>
        </header>
        <MarkdownReader>{contents}</MarkdownReader>
      </article>
      <p className="my-4 text-foreground-secondary">
        Like this post?{" "}
        <ShareButton
          url="https://twitter.com/intent/tweet"
          params={{
            text: `I'd like to share this post from @GmhLovEDM:\n${shareUrl}`,
          }}
        >
          Tweet
        </ShareButton>{" "}
        to share it with others or{" "}
        <ShareButton url="https://github.com/gmhlovedm/GmhLovEDM.github.io/issues">
          open an issue
        </ShareButton>{" "}
        to discuss with me!
      </p>
    </>
  );
}
export default BlogPost;
