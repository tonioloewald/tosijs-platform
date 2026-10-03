/**
 * Performance-related configuration for prefetch behavior.
 * These settings are kept in code to avoid record fetches on every request.
 */

export const config = {
  /**
   * The head when nothing more specific applies (was hardcoded in prefetch.ts).
   */
  defaultHead: {
    title: 'inconsequence',
    description: 'musings on subjects of passing interest',
  },

  /**
   * When true, blog data (latest posts, recent posts) is prefetched on every
   * page request. Recommended for blog-centric sites where most visitors
   * will navigate to blog content.
   *
   * When false, blog data is only prefetched when explicitly configured
   * via a page's prefetch array.
   */
  alwaysPrefetchBlog: true,

  /**
   * When alwaysPrefetchBlog is true and no specific post matches the URL,
   * setting this to true will use the latest post's metadata (title, description,
   * image) for the page's OpenGraph tags. Useful for blog homepages.
   */
  defaultToBlogMetadata: true,
}
