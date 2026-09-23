/**
 * The classifier against real post text, labelled by hand.
 *
 * The first two are the posts the classifier was tuned on (Abhishek Sharma,
 * 1w and 2w old at the time), exactly as far as LinkedIn showed them before
 * "…more". The rest are real requirement posts found through the engine
 * path, and the posts that most often get mistaken for them: trainers
 * advertising themselves, institutes advertising courses, agencies selling a
 * trainer pool, thank-you posts, and job seekers.
 *
 * A post added here is a promise: a later change to the cues that breaks one
 * of these is a regression, whatever else it improves.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { classifyPost, engagementOf } from '../src/lib/posts.js';

const DEMAND = {
  'QA automation trainer (screenshot, 1w)':
    'Hi Connections, A QA Automation corporate trainer is required in an IT company. Required skillsets are ' +
    'mentioned below: Company is especially interested in corporate trainers with hands-on experience in: ' +
    '✅ Cypress – End-to-end automation ✅ Playwright – Modern browser automation ✅ Guard rail – AI safety and ' +
    'quality controls ✅ Evals – Evaluating AI-powered applications Additional skills that matter:',
  'Technical Training Specialist (screenshot, 2w)':
    'Part Time or Freelancing Technical Training Specialist (AI, Machine Learning, & Business Intelligence) is ' +
    'required !! Position Overview: We are seeking an experienced and versatile Technical Training Specialist ' +
    'to lead comprehensive technology programs that can enhance the Python skills of our company colleagues ' +
    'and keep them updated. This role is responsible for delivering hands-on instruction across three core ' +
    'verticals: Generative AI and AI Agents, Data Science & Machine Learning, and Data Analytics &',
  'the same, with a requirement’s usual perks and history':
    'Technical Training Specialist is required. We offer flexible hours and attractive pay. Candidates should ' +
    'have delivered corporate training programs for 5+ years and completed at least 20 workshops. ' +
    'I am looking for someone who can start next week.',
  'urgent requirement, Pune':
    '🚨🔥 URGENT CORPORATE TRAINER REQUIREMENT – PUNE 🔥🚨 We are urgently looking for experienced Corporate ' +
    'Trainers | Freelancers | Industry Mentors for a 2-MONTH TRAINING PROGRAM focused on GenAI & AI in Software ' +
    'Testing. 📍 Location: Pune 📅 Start Date: 10th September 2026 💰 Commercials: ₹8,000 Per Day',
  'SAP FI onsite':
    '🚨 URGENT SAP FI TRAINER REQUIREMENT – DADAR, MUMBAI🚨 📢 We are urgently looking for an experienced SAP FI ' +
    'Trainer for an onsite training program. Mode: Onsite Duration: 80 Hours. Interested trainers: Please DM ' +
    'your updated profile, training experience & availability.',
  'NetSuite classroom':
    'URGENT TRAINER REQUIREMENT – NETSUITE | HYDERABAD We are urgently looking for an experienced Oracle NetSuite ' +
    'Corporate Trainer / Freelancer Trainer for an upcoming classroom training program. Training Dates: 10th & ' +
    '11th September 2026.',
  'dear trainers, leadership programme':
    'Dear Trainers, We are currently looking for experienced Freelance Corporate Trainers who can deliver an ' +
    'engaging and impactful Customer Leadership Development Training program. Interested trainers are ' +
    'requested to connect with me or share their profile for further details.',
  'freelance trainer needed, UAE':
    'URGENT | Freelance Trainer Needed | Advanced Excel & Power BI | UAE. We have an immediate requirement and ' +
    'need someone ready to hit the ground running. Freelancers only — this is not a full-time position.',
  'CSR project consultants':
    'We are looking for Freelance Business Communication & Aptitude Training Consultants for an MNC’s CSR ' +
    'Project across the following locations. Interested freelance consultants may share their profile.',
  'a recruiter in the first person':
    'I am hiring a corporate trainer for our client in Pune. Share your CV.',
  'a company that needs training, not a trainer':
    'Our sales team of 40 needs a 2-day negotiation skills workshop in Chennai next month. Corporate training ' +
    'required — please recommend vendors or DM me.',
  'a referral ask':
    'Can anyone recommend a good Power BI trainer for a corporate batch in Bangalore? Budget is flexible.',
  'full-time hiring still asks for a trainer':
    'WE’RE HIRING: FULL-TIME AI CORPORATE TRAINER. We are looking for a Full-Time AI Corporate Trainer who can ' +
    'train business owners and their teams on AI & Business Automation.',
};

const NOT_DEMAND = {
  'a trainer selling, in the buyer’s words': [
    'I am a certified corporate trainer, available for corporate training sessions. If you require soft ' +
      'skills training, DM me.',
    'SUPPLY',
  ],
  'a trainer who "requires" nothing': [
    'I’m a Microsoft Certified Trainer with 12 years of experience. If your team needs Azure training, ' +
      'I’m available for freelance assignments. Reach out.',
    'SUPPLY',
  ],
  'an institute advert': ['New batch starts Monday! Enroll now, limited seats. Join our Power BI course.', 'SUPPLY'],
  'an agency selling its trainer pool': [
    'Looking for corporate trainers? We have a pool of 500+ certified trainers. If you need training for your ' +
      'employees, contact us today.',
    'SUPPLY',
  ],
  'a job seeker': ['Looking for new opportunities as a corporate trainer #opentowork', 'SUPPLY'],
  'a thank-you': [
    'Successfully conducted a 3-day corporate training at Acme. Thank you for the opportunity!',
    'RECAP',
  ],
  'a first-person recap': [
    'Yesterday I delivered a Power BI training for the finance team at Globex. Grateful for the energy in the room.',
    'RECAP',
  ],
  'a thank-you that starts with need': ['I need to thank everyone who came to the workshop', 'OTHER'],
  'a hiring post for a different role': ['We are hiring a sales executive in Chennai. Apply now.', 'OTHER'],
};

for (const [name, text] of Object.entries(DEMAND)) {
  test(`DEMAND: ${name}`, () => {
    const r = classifyPost(text, { topic: 'corporate trainer' });
    assert.equal(r.intent, 'DEMAND', `${r.intent} — ${r.signals.join(', ')}`);
  });
}

for (const [name, [text, want]] of Object.entries(NOT_DEMAND)) {
  test(`${want}: ${name}`, () => {
    const r = classifyPost(text, { topic: 'corporate trainer' });
    assert.equal(r.intent, want, `${r.intent} — ${r.signals.join(', ')}`);
  });
}

test('the two screenshot posts say why they were kept', () => {
  const r = classifyPost(DEMAND['Technical Training Specialist (screenshot, 2w)']);
  assert.ok(r.signals.includes('asks for a trainer'), r.signals.join(', '));
  assert.ok(r.signals.includes('requirement details'), 'Position Overview reads as a requirement');
  assert.ok(!r.signals.some((s) => s.startsWith('not:')), r.signals.join(', '));
});

test('a requirement says what kind of engagement it is', () => {
  assert.equal(engagementOf(DEMAND['Technical Training Specialist (screenshot, 2w)']), 'freelance, part-time');
  assert.equal(engagementOf(DEMAND['full-time hiring still asks for a trainer']), 'full-time');
  assert.equal(engagementOf(DEMAND['QA automation trainer (screenshot, 1w)']), '');
});
