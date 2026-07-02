// Fetch daily trending topics from free public endpoints and bias toward
// wholesome/animal/family-friendly angles that fit our animated character format.

const KID_FRIENDLY_TEMPLATES = [
  (topic: string) => `a curious little animal discovers what "${topic}" means and has a funny adventure`,
  (topic: string) => `a tiny hero tries to help their friend with "${topic}" and things go delightfully wrong`,
  (topic: string) => `a small character wakes up and finds their world changed because of "${topic}"`,
  (topic: string) => `a brave little animal enters a magical contest about "${topic}"`,
  (topic: string) => `a shy hero learns a big lesson about kindness while dealing with "${topic}"`,
];

const BLOCKLIST = /\b(kill|death|died|dead|war|attack|shooting|nude|nsfw|scandal|arrest|crime|murder|violence|drug|porn|sex|racist|political|election|trump|biden|palestine|israel|ukraine|russia|hamas)\b/i;

const FALLBACK_TOPICS = [
  "a magical hidden garden",
  "a lost umbrella on a rainy day",
  "the last cookie in the jar",
  "a mysterious glowing pebble",
  "a talking rubber duck",
  "the biggest snowflake ever",
  "a firefly who lost their glow",
  "a tiny boat sailing a puddle",
  "an ice cream that never melts",
  "a whistling teapot who is shy",
  "a paper airplane on a big journey",
  "the secret door under the stairs",
];

async function fetchGoogleTrends(geo = "US"): Promise<string[]> {
  try {
    const res = await fetch(`https://trends.google.com/trending/rss?geo=${geo}`, {
      headers: { "User-Agent": "Mozilla/5.0 ShortForge/1.0" },
    });
    if (!res.ok) return [];
    const xml = await res.text();
    const titles = [...xml.matchAll(/<title>([^<]+)<\/title>/g)].map((m) => m[1].trim());
    // First title is the feed name; skip it.
    return titles.slice(1, 25).filter((t) => !BLOCKLIST.test(t));
  } catch {
    return [];
  }
}

export type TrendingPick = { rawTopic: string; storyPrompt: string; source: "google-trends" | "fallback" };

export async function pickTrendingTopic(seed = Date.now()): Promise<TrendingPick> {
  const trends = await fetchGoogleTrends("US");
  const rng = (n: number) => Math.floor((Math.sin(seed) * 10000) % n + n) % n;
  if (trends.length) {
    const topic = trends[rng(trends.length)];
    const template = KID_FRIENDLY_TEMPLATES[rng(KID_FRIENDLY_TEMPLATES.length)];
    return { rawTopic: topic, storyPrompt: template(topic.toLowerCase()), source: "google-trends" };
  }
  const fallback = FALLBACK_TOPICS[rng(FALLBACK_TOPICS.length)];
  return { rawTopic: fallback, storyPrompt: fallback, source: "fallback" };
}
