export const HELP_TOPICS = [
  {
    slug: 'help-with-a-run',
    title: 'Help with a run',
    summary: 'Troubleshooting upload, parsing, optimization, and validation issues for runs.',
    faqs: [
      'My run failed after upload. What should I check first?',
      'How do I validate if a completed run is correct?',
      'Why are some employees not assigned in the result?'
    ]
  },
  {
    slug: 'account',
    title: 'Account',
    summary: 'Manage login, profile details, security, and account preferences.',
    faqs: [
      'How can I update my profile details?',
      'I cannot log in with Google. What should I do?',
      'How do I reset my password?'
    ]
  },
  {
    slug: 'membership',
    title: 'Usage',
    summary: 'Information about platform access, upload scope, and large testcase runs.',
    faqs: [
      'What upload limits apply to project files?',
      'How are large testcase runs handled?',
      'Are advanced solver settings available to all users?'
    ]
  },
  {
    slug: 'accessibility',
    title: 'Accessibility',
    summary: 'Support for accessibility, readability, and UI interaction options.',
    faqs: [
      'Can I increase UI text size in the app?',
      'Does the app support keyboard-only navigation?',
      'How can I report an accessibility issue?'
    ]
  },
  {
    slug: 'grievance-redressal',
    title: 'Grievance redressal',
    summary: 'Raise escalations and track issue resolution timelines.',
    faqs: [
      'How do I escalate an unresolved issue?',
      'What details should I include in a grievance report?',
      'How long does escalation review take?'
    ]
  },
  {
    slug: 'guides',
    title: 'Guides',
    summary: 'Step-by-step onboarding and best-practice workflows.',
    faqs: [
      'How do I run my first optimization?',
      'What is the recommended dataset format?',
      'How do I compare run performance across dates?'
    ]
  },
  {
    slug: 'shuttle',
    title: 'Shuttle',
    summary: 'Guidance for shuttle-style routing use cases and scheduling.',
    faqs: [
      'How do I configure shuttle routes for fixed pickup points?',
      'Can I schedule recurring shuttle runs?',
      'How should I model capacity limits in shuttle mode?'
    ]
  },
  {
    slug: 'cancellation-policy',
    title: 'Cancellation policy',
    summary: 'Policy information for cancellations, modifications, and reversals.',
    faqs: [
      'Can I cancel a scheduled run before execution?',
      'What happens if I cancel an ongoing run?',
      'Can I restore a deleted run?'
    ]
  },
  {
    slug: 'map-issue',
    title: 'Map issue',
    summary: 'Fixes for map rendering, wrong route paths, and marker issues.',
    faqs: [
      'Why are route lines not visible on the map?',
      'How do I report incorrect pickup/drop coordinates?',
      'Why does fullscreen map still show overlay sections?'
    ]
  }
];

export const HELP_TOPIC_MAP = HELP_TOPICS.reduce((acc, topic) => {
  acc[topic.slug] = topic;
  return acc;
}, {});
