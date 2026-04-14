// @ts-check
import sitemap from "@astrojs/sitemap";
import starlight from "@astrojs/starlight";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "astro/config";
import starlightBlog from "starlight-blog";

export default defineConfig({
  site: "https://alchemy-effect.run",
  prefetch: true,
  trailingSlash: "ignore",
  integrations: [
    sitemap({
      filter: (page) =>
        !page.endsWith(".html") &&
        !page.endsWith(".md") &&
        !page.endsWith(".mdx"),
    }),
    starlight({
      title: "alchemy-effect",
      favicon: "/favicon.png",
      customCss: ["./src/styles/global.css", "./src/styles/custom.css"],
      prerender: true,
      social: [
        {
          icon: "github",
          label: "GitHub",
          href: "https://github.com/alchemy-run/alchemy-effect",
        },
      ],
      editLink: {
        baseUrl:
          "https://github.com/alchemy-run/alchemy-effect/edit/main/website",
      },
      sidebar: [
        { label: "Getting Started", link: "/getting-started" },
        { label: "What is Alchemy?", link: "/what-is-alchemy" },
        {
          label: "Concepts",
          autogenerate: { directory: "concepts" },
        },
        {
          label: "Guides",
          autogenerate: { directory: "guides" },
          collapsed: true,
        },
        {
          label: "Providers",
          autogenerate: { directory: "providers", collapsed: true },
        },
      ],
      plugins: [starlightBlog()],
    }),
  ],
  vite: {
    plugins: [tailwindcss()],
  },
});
