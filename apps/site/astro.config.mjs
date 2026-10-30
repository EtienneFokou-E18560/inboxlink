// @ts-check
import { defineConfig } from "astro/config";
import starlight from "@astrojs/starlight";
import starlightLlmsTxt from "starlight-llms-txt";

const repo = "https://github.com/EtienneFokou-E18560/inboxlink";

export default defineConfig({
  site: "https://inboxlink.cieltd.org",
  integrations: [
    starlight({
      title: "InboxLink",
      description:
        "Open-source mailbox connection infrastructure: hosted Gmail Connect, vaulted OAuth tokens and a normalized messages API.",
      logo: { src: "./src/assets/mark.svg", replacesTitle: false },
      favicon: "/favicon.svg",
      head: [
        {
          // The site moved from getinboxlink.vercel.app; send visitors on the old host to the same page.
          // (A host-based rule in vercel.json was not applied to this project's .vercel.app alias.)
          tag: "script",
          content:
            'if (location.hostname === "getinboxlink.vercel.app") location.replace("https://inboxlink.cieltd.org" + location.pathname + location.search + location.hash);',
        },
        // Vercel Web Analytics (served by Vercel on the same origin once enabled for the project).
        { tag: "script", attrs: { defer: true, src: "/_vercel/insights/script.js" } },
      ],
      social: [{ icon: "github", label: "GitHub", href: repo }],
      editLink: { baseUrl: `${repo}/edit/main/apps/site/` },
      lastUpdated: true,
      customCss: ["./src/styles/theme.css"],
      plugins: [starlightLlmsTxt()],
      sidebar: [
        { label: "Start here", items: [{ label: "Quick start", slug: "quick-start" }] },
        {
          label: "Guides",
          items: [
            { label: "Connect flow", slug: "guides/connect-flow" },
            { label: "Messages API", slug: "guides/messages" },
            { label: "Sync and webhooks", slug: "guides/sync-and-webhooks" },
          ],
        },
        {
          label: "Reference",
          items: [
            { label: "SDK", slug: "reference/sdk" },
            { label: "Changelog", slug: "changelog" },
            { label: "Roadmap", slug: "roadmap" },
            { label: "Glossary", slug: "reference/glossary" },
          ],
        },
        {
          label: "Operate",
          items: [
            { label: "Self-hosting", slug: "operate/self-host" },
            { label: "Security", slug: "security" },
            { label: "For mailbox owners", slug: "for-mailbox-owners" },
            { label: "Status", link: "https://inboxlink-two.vercel.app/status", attrs: { target: "_blank" } },
          ],
        },
      ],
    }),
  ],
});
