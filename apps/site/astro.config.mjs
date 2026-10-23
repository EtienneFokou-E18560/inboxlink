// @ts-check
import { defineConfig } from "astro/config";
import starlight from "@astrojs/starlight";

const repo = "https://github.com/EtienneFokou-E18560/inboxlink";

export default defineConfig({
  site: "https://getinboxlink.vercel.app",
  integrations: [
    starlight({
      title: "InboxLink",
      description:
        "Open-source mailbox connection infrastructure: hosted Gmail Connect, vaulted OAuth tokens and a normalized messages API.",
      logo: { src: "./src/assets/mark.svg", replacesTitle: false },
      favicon: "/favicon.svg",
      social: [{ icon: "github", label: "GitHub", href: repo }],
      editLink: { baseUrl: `${repo}/edit/main/apps/site/` },
      lastUpdated: true,
      customCss: ["./src/styles/theme.css"],
      sidebar: [
        { label: "Start here", items: [{ label: "Quick start", slug: "quick-start" }] },
      ],
    }),
  ],
});
