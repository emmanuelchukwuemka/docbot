// Seed data for the MigraTech knowledge base.
//
// IMPORTANT: Every pathway/FAQ below is marked isVerifiedContent=false and carries no
// sourceUrl/lastVerifiedAt. This is intentional. Per PRD section 13 (FR-06) and section 26
// (AI Guardrails), the bot "should never rely solely on static AI knowledge for current
// immigration requirements," and every regulatory record needs a real
// Source -> Date Verified -> Country -> Pathway -> Version trail before it is presented to
// users as fact.
//
// This seed data exists only so the app has something to run against in development. A
// MigraTech migration specialist must review, correct, and verify each row (and flip
// isVerifiedContent=true with a real sourceUrl and lastVerifiedAt) before any of it reaches
// a real user.

export const COUNTRIES = [
  {
    name: "Germany",
    code: "DE",
    official_resources: [{ label: "Make it in Germany (Federal Government)", url: "https://www.make-it-in-germany.com" }],
  },
  {
    name: "Canada",
    code: "CA",
    official_resources: [
      { label: "Immigration, Refugees and Citizenship Canada (IRCC)", url: "https://www.canada.ca/en/immigration-refugees-citizenship.html" },
    ],
  },
  {
    name: "United Kingdom",
    code: "UK",
    official_resources: [{ label: "UK Visas and Immigration (gov.uk)", url: "https://www.gov.uk/browse/visas-immigration" }],
  },
];

export const PATHWAYS = [
  {
    country: "Germany",
    name: "Skilled Worker Route",
    category: "work",
    summary:
      "For applicants with a recognized qualification and relevant professional " +
      "experience seeking employment in Germany.",
    eligibility_criteria: {
      min_age: null,
      education: "Recognized degree or vocational qualification",
      experience_years_min: null,
      language: "German and/or English proficiency, depending on role",
      job_offer_required: "Improves eligibility; some routes allow job-seeking",
    },
    requirements: [
      "Recognized academic or vocational qualification",
      "Relevant professional experience",
      "Proof of language ability where applicable",
    ],
    documents: [
      "International passport",
      "Academic certificates",
      "Academic transcripts",
      "CV",
      "Employment references",
      "Professional credentials",
      "Language certificate where applicable",
      "Proof of funds where applicable",
      "Employment contract/job offer where applicable",
    ],
    government_fees: "Varies by visa category — confirm with a MigraTech specialist",
    service_fees: "Confirm with a MigraTech specialist",
    typical_processing_time: "Varies — confirm with a MigraTech specialist",
    language_requirements: "German and/or English, depending on occupation and employer",
  },
  {
    country: "Germany",
    name: "Study Route",
    category: "study",
    summary: "For applicants pursuing further education (undergraduate, master's, PhD) in Germany.",
    eligibility_criteria: {
      admission_offer_required: true,
      financial_proof_required: true,
    },
    requirements: [
      "Offer of admission from a recognized institution",
      "Proof of financial resources",
      "Language proficiency where required by the institution",
    ],
    documents: [
      "International passport",
      "Academic certificates and transcripts",
      "Admission letter",
      "Proof of funds",
      "Language certificate where applicable",
    ],
    government_fees: "Varies — confirm with a MigraTech specialist",
    service_fees: "Confirm with a MigraTech specialist",
    typical_processing_time: "Varies — confirm with a MigraTech specialist",
    language_requirements: "Depends on the institution and programme",
  },
  {
    country: "Canada",
    name: "Skilled Worker Pathway",
    category: "work",
    summary:
      "For skilled professionals seeking to work and potentially settle in Canada. " +
      "Eligibility depends on factors such as age, language proficiency, education " +
      "and work experience.",
    eligibility_criteria: {
      education: "Assessed qualification",
      experience_years_min: null,
      language: "English and/or French proficiency assessed via standardized test",
      age_considered: true,
    },
    requirements: [
      "Relevant work experience",
      "Language test results",
      "Educational credential assessment where applicable",
    ],
    documents: [
      "International passport",
      "Academic certificates",
      "CV",
      "Employment references",
      "Language test results",
      "Proof of funds",
    ],
    government_fees: "Varies — confirm with a MigraTech specialist",
    service_fees: "Confirm with a MigraTech specialist",
    typical_processing_time: "Varies — confirm with a MigraTech specialist",
    language_requirements: "English and/or French, assessed via standardized test",
  },
  {
    country: "United Kingdom",
    name: "Skilled Worker Route",
    category: "work",
    summary: "For applicants with a job offer from a licensed UK sponsor in an eligible occupation.",
    eligibility_criteria: {
      job_offer_required: true,
      sponsor_license_required: true,
      language: "English proficiency required",
    },
    requirements: [
      "Job offer from a licensed sponsor",
      "Certificate of sponsorship",
      "English language proficiency",
    ],
    documents: [
      "International passport",
      "Certificate of sponsorship reference number",
      "Academic certificates where applicable",
      "Proof of funds where applicable",
      "English language evidence",
    ],
    government_fees: "Varies — confirm with a MigraTech specialist",
    service_fees: "Confirm with a MigraTech specialist",
    typical_processing_time: "Varies — confirm with a MigraTech specialist",
    language_requirements: "English proficiency required",
  },
  {
    country: "United Kingdom",
    name: "Family Route",
    category: "family",
    summary: "For applicants seeking to join a spouse, partner, or family member already in the UK.",
    eligibility_criteria: {
      relationship_evidence_required: true,
      financial_requirement: true,
    },
    requirements: [
      "Proof of relationship",
      "Proof of accommodation",
      "Proof of income/financial requirement",
    ],
    documents: [
      "International passport",
      "Marriage/relationship certificate",
      "Proof of accommodation",
      "Financial evidence",
    ],
    government_fees: "Varies — confirm with a MigraTech specialist",
    service_fees: "Confirm with a MigraTech specialist",
    typical_processing_time: "Varies — confirm with a MigraTech specialist",
    language_requirements: "English proficiency may be required",
  },
];

export const FAQS = [
  {
    question: "How much does migration cost?",
    answer:
      "Costs vary widely by destination, pathway, and whether you use professional " +
      "support — they typically include government/visa fees, language testing, " +
      "document costs, and any service fees. A MigraTech specialist can give you a " +
      "cost breakdown for your specific pathway.",
    category: "cost",
  },
  {
    question: "How long does the process take?",
    answer:
      "Processing times depend on the destination country, pathway, and current " +
      "government processing volumes. We can give you a general estimate once we " +
      "know your destination and pathway, and a specialist can confirm current timelines.",
    category: "timeline",
  },
  {
    question: "Can I migrate without a job offer?",
    answer:
      "Some pathways require a job offer and some don't — it depends on the country " +
      "and route (for example, some skilled-worker pathways assess points/eligibility " +
      "independent of a job offer, while others require sponsorship). Tell us your " +
      "destination and we can narrow this down.",
    category: "eligibility",
  },
  {
    question: "Can my family come with me?",
    answer:
      "Many work and study pathways allow eligible family members to join you, " +
      "subject to the destination country's rules. Let us know who you'd like to " +
      "bring and we'll flag the relevant considerations.",
    category: "family",
  },
  {
    question: "What documents do I need?",
    answer:
      "This depends on your pathway. Common documents include your passport, " +
      "academic certificates, CV, employment references, and language test results. " +
      "Once we know your goal and destination, I can generate a personalized checklist.",
    category: "documents",
  },
  {
    question: "Do I need IELTS?",
    answer:
      "Some pathways require a standardized language test (such as IELTS) and some " +
      "don't, depending on the destination and your background. We can confirm this " +
      "once we know your destination and occupation.",
    category: "documents",
  },
  {
    question: "What happens after my visa is approved?",
    answer:
      "Next steps typically include travel/relocation logistics and any registration " +
      "requirements in the destination country. A MigraTech specialist can walk you " +
      "through this once you're at that stage.",
    category: "process",
  },
];
