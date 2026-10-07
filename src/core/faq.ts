// Fixed answers for simple services questions, written from services.md.
// The LLM only picks the topic; it never writes the answer, so it cannot
// invent a service, an area or a number.

export type FaqTopic =
  | "services" | "service_area" | "timelines" | "commercial" | "not_offered" | "rented";

export const FAQ_ANSWERS: Record<FaqTopic, string> = {
  services:
    "Aangan Studio does end-to-end interior design for homes and small offices in Pune and PCMC — space planning, materials, furniture, lighting, kitchens and wardrobes, and we supervise the execution with our own contractors.",
  service_area:
    "We work across Pune city and PCMC, including Pimpri, Chinchwad, Pimple Saudagar, Ravet and Hinjewadi. We don't currently take projects outside that area.",
  timelines:
    "The design phase takes three to four weeks from the first consultation, and execution usually takes eight to sixteen weeks depending on the size of the project. We need at least six weeks before execution can begin.",
  commercial:
    "For offices, clinics and studios we take projects up to about three thousand square feet, including workstations, cabins, reception and common areas.",
  not_offered:
    "We don't do architecture or structural work, decor or styling on its own, standalone furniture sourcing, Vastu-only advice, or restaurants, hotels, retail stores and gyms.",
  rented:
    "Yes, we've worked on rented apartments, as long as there are no structural changes.",
};

export const FAQ_TOPICS = Object.keys(FAQ_ANSWERS) as FaqTopic[];
