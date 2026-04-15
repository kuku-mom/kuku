export interface BlogPost {
  slug: string;
  /** ISO date string */
  date: string;
  title: string;
  excerpt: string;
  author: string;
  image: string;
  imageAlt: string;
  /** Short article body for the detail page (plain text, single column). */
  body: string[];
}

export const blogPosts: BlogPost[] = [
  {
    slug: "kuku-roadmap-journey",
    date: "2026-02-06",
    title: "Kuku Roadmap: The Journey Toward Complete Freedom",
    excerpt:
      "How we are thinking about local-first workflows, open building blocks, and a calm editor that stays out of your way—plus what is shipping next.",
    author: "Gyeongtaek Kim",
    image: "/blog-1.webp",
    imageAlt: "Illustration of a character exploring a forest path",
    body: [
      "We built kuku because we wanted a Markdown home that feels fast, local, and honest. The roadmap is not a wish list—it is the sequence of bets we are making to keep your notes yours, with optional cloud only when it earns its place.",
      "This year we are focused on rock-solid editing, thoughtful AI that respects context, and sync that does not surprise you at the door. We will share milestones as they land, with clear defaults and an escape hatch if you want to stay offline.",
      "Thank you for trying early builds. Your feedback is shaping what “complete freedom” means in practice—not just a slogan.",
    ],
  },
  {
    slug: "quiet-surface-editor-design",
    date: "2026-01-18",
    title: "A Quiet Surface: Designing the kuku Editor",
    excerpt:
      "Typography, spacing, and contrast choices for a One Light workspace that feels calm for long writing sessions and sharp for quick captures.",
    author: "Gyeongtaek Kim",
    image: "/blog-2.webp",
    imageAlt: "Abstract line illustration on a dark grid background",
    body: [
      "Minimal interfaces are easy to mock up and hard to live with. We iterated on density, focus rings, and panel rhythm until the UI felt invisible during real writing—not only in screenshots.",
      "The goal is a single column that reads like paper, with side tools that appear when you need them and stay out of the way when you do not.",
      "We will keep tuning with real vaults and long documents. If something feels noisy, we want to hear it.",
    ],
  },
];

export function getBlogPost(slug: string): BlogPost | undefined {
  return blogPosts.find((p) => p.slug === slug);
}
