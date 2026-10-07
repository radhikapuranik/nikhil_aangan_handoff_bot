// Business rules from services.md, qualified.md and qualification-logic.md.
// Values marked ASSUMPTION are not stated in those files; Nikhil should confirm.

export const MIN_LEAD_WEEKS = 6; // services.md: no execution start in under 6 weeks
export const CALLBACK_MINUTES = 15;

// services.md lists these by name "and adjoining areas".
export const SERVICE_AREAS_LISTED = [
  "pune", "pcmc", "pimpri chinchwad", "pimpri-chinchwad",
  "kothrud", "baner", "aundh", "wakad", "koregaon park", "kalyani nagar",
  "viman nagar", "hadapsar", "magarpatta", "nibm", "kondhwa", "undri",
  "shivane", "warje", "erandwane", "deccan",
  "pimpri", "chinchwad", "pimple saudagar", "pimple nilakh", "ravet", "hinjewadi",
];

// ASSUMPTION: other Pune neighbourhoods treated as "adjoining areas".
// Needed because real transcripts mention Kharadi, Nanded City, etc.
export const SERVICE_AREAS_ADJOINING = [
  "kharadi", "nanded city", "sunderban", "dahanukar colony", "pashan", "balewadi",
  "bavdhan", "wanowrie", "camp", "swargate", "sinhagad road", "karve nagar",
  "yerawada", "mundhwa", "kalyani", "cybercity", "sangvi", "pimple gurav",
  "wagholi", "katraj", "bibwewadi", "sadashiv peth", "shivajinagar", "model colony",
];

// qualification-logic.md: hard boundary, no exceptions.
export const HARD_OUT_OF_AREA = ["talegaon", "lonavala", "nashik", "mumbai"];

// ASSUMPTION: other cities, so "Nagpur" fails rather than being "unclear".
export const OTHER_CITIES = [
  "nagpur", "bangalore", "bengaluru", "delhi", "hyderabad", "chennai", "kolkata",
  "ahmedabad", "kolhapur", "satara", "solapur", "aurangabad", "navi mumbai", "thane",
  "goa", "surat", "indore",
];

// services.md: commercial up to approximately 3,000 sq ft.
export const COMMERCIAL_MAX_SQFT = 3000;
// ASSUMPTION: the 500 sq ft floor comes only from a front-desk line in T18,
// not from services.md.
export const COMMERCIAL_MIN_SQFT = 500;

// Budget alignment. INTERNAL ONLY, derived from pricing.md. These numbers are
// never spoken to a caller.
// ASSUMPTION: "clearly below" means under 60% of the lowest indicative figure
// for the described scope.
export const BUDGET_CLEARLY_BELOW_RATIO = 0.6;
export const BUDGET_FLOOR_LAKH = {
  singleRoom: 3.5, // pricing.md: single room all-in, low end
  perSqftHome: 0.018, // Rs 1,800 per sq ft, in lakh
  perSqftCommercial: 0.012, // Rs 1,200 per sq ft, in lakh
};
