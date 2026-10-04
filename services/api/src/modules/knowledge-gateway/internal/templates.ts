// Department templates (feature 26): ready-made topic lists and job-role maps a company can apply and then edit.
//
// WRITTEN BY US, NOT VALIDATED BY AN INDUSTRY EXPERT. They are generic starting points: a company is expected to
// rename, remove and add. They are data in the repository, not rows in the database; applying one creates ordinary
// topics and map entries through the same functions as creating them by hand (routes-topics.ts: insertTopic,
// linkRoleTopic, embedTopic). The library is checked when this file is loaded: a broken template stops the start.

export interface TemplateTopic {
  /** Unique inside the template; job roles refer to topics by this key. */
  key: string;
  name: string;
  description: string;
}
export interface TemplateRole {
  job_role: string;
  topics: ReadonlyArray<{ key: string; required: boolean; importance: 1 | 2 | 3 }>;
}
export interface DepartmentTemplate {
  key: string;
  name: string;
  summary: string;
  topics: readonly TemplateTopic[];
  roles: readonly TemplateRole[];
}

const need = (key: string, importance: 1 | 2 | 3 = 2, required = true) => ({ key, required, importance });

export const DEPARTMENT_TEMPLATES: readonly DepartmentTemplate[] = [
  {
    key: 'production-line',
    name: 'Production line',
    summary: 'Running, changing over and cleaning a line.',
    topics: [
      { key: 'startup', name: 'Line start-up and shutdown', description: 'The order of steps, settings and checks to start and stop the line.' },
      { key: 'changeover', name: 'Product changeover', description: 'What is changed between products or formats, and how long it takes.' },
      { key: 'faults', name: 'Common faults and first response', description: 'Recurring faults, what they mean and what to do first.' },
      { key: 'quality-checks', name: 'In-process quality checks', description: 'What is checked on the line, how often, and the limits.' },
      { key: 'cleaning', name: 'Cleaning and sanitation', description: 'Cleaning routines, agents, times and release criteria.' },
      { key: 'safety', name: 'Line safety rules', description: 'Lock-out, guarding and other rules for working on the line.' },
    ],
    roles: [
      { job_role: 'Line operator', topics: [need('startup', 3), need('changeover'), need('faults', 3), need('quality-checks'), need('cleaning'), need('safety', 3)] },
      { job_role: 'Shift leader', topics: [need('startup'), need('changeover', 3), need('faults', 3), need('quality-checks', 3), need('safety', 3)] },
    ],
  },
  {
    key: 'maintenance',
    name: 'Maintenance',
    summary: 'Keeping equipment running and repairing it.',
    topics: [
      { key: 'preventive', name: 'Preventive maintenance routines', description: 'What is serviced, at which intervals, with which parts and tools.' },
      { key: 'breakdowns', name: 'Breakdown diagnosis', description: 'How typical breakdowns are found and repaired.' },
      { key: 'spares', name: 'Spare parts and suppliers', description: 'Critical spares, where they are kept and who supplies them.' },
      { key: 'lubrication', name: 'Lubrication', description: 'Lubricants, points and intervals.' },
      { key: 'isolation', name: 'Isolation and lock-out', description: 'How energy sources are isolated before work.' },
      { key: 'utilities', name: 'Utilities', description: 'Compressed air, steam, water, power: layout and known weak points.' },
    ],
    roles: [
      { job_role: 'Maintenance technician', topics: [need('preventive', 3), need('breakdowns', 3), need('spares'), need('lubrication'), need('isolation', 3), need('utilities', 1, false)] },
      { job_role: 'Maintenance planner', topics: [need('preventive', 3), need('spares', 3), need('utilities')] },
    ],
  },
  {
    key: 'quality-lab',
    name: 'Quality laboratory',
    summary: 'Sampling, testing and releasing product.',
    topics: [
      { key: 'sampling', name: 'Sampling plans', description: 'What is sampled, where, how often and how samples are handled.' },
      { key: 'methods', name: 'Test methods', description: 'How each test is carried out and what can go wrong.' },
      { key: 'limits', name: 'Specifications and limits', description: 'The limits that apply and what happens outside them.' },
      { key: 'calibration', name: 'Instrument calibration', description: 'Which instruments are calibrated, how and when.' },
      { key: 'release', name: 'Hold and release', description: 'Who may hold or release product, and on what evidence.' },
      { key: 'complaints', name: 'Complaints and investigations', description: 'How a complaint is investigated and recorded.' },
    ],
    roles: [
      { job_role: 'Laboratory technician', topics: [need('sampling', 3), need('methods', 3), need('limits'), need('calibration')] },
      { job_role: 'Quality manager', topics: [need('limits', 3), need('release', 3), need('complaints', 3), need('sampling')] },
    ],
  },
  {
    key: 'warehouse',
    name: 'Warehouse and logistics',
    summary: 'Receiving, storing and shipping goods.',
    topics: [
      { key: 'receiving', name: 'Goods receiving', description: 'Checks at receipt, booking in and handling of deviations.' },
      { key: 'storage', name: 'Storage rules', description: 'Where things go, stacking, temperature and separation rules.' },
      { key: 'picking', name: 'Picking and loading', description: 'How orders are picked, checked and loaded.' },
      { key: 'stock', name: 'Stock counts and corrections', description: 'Counting routines and how differences are handled.' },
      { key: 'trucks', name: 'Fork-lift and equipment rules', description: 'Daily checks, charging and rules of use.' },
      { key: 'carriers', name: 'Carriers and documents', description: 'Who carries what, the documents needed and contacts.' },
    ],
    roles: [
      { job_role: 'Warehouse operative', topics: [need('receiving'), need('storage', 3), need('picking', 3), need('trucks', 3)] },
      { job_role: 'Warehouse supervisor', topics: [need('receiving', 3), need('stock', 3), need('carriers', 3), need('storage')] },
    ],
  },
  {
    key: 'it-operations',
    name: 'IT operations',
    summary: 'Keeping systems available and recovering them.',
    topics: [
      { key: 'landscape', name: 'System landscape', description: 'Which systems exist, what depends on what, and who owns them.' },
      { key: 'backup', name: 'Backup and restore', description: 'What is backed up, where, and how a restore is done and tested.' },
      { key: 'access', name: 'Accounts and access', description: 'How access is granted, reviewed and removed.' },
      { key: 'incidents', name: 'Incident handling', description: 'Known incidents, how they were found and fixed.' },
      { key: 'changes', name: 'Changes and releases', description: 'How a change is prepared, approved, rolled out and rolled back.' },
      { key: 'vendors', name: 'Vendors and contracts', description: 'Support contacts, contract terms and renewal dates.' },
    ],
    roles: [
      { job_role: 'System administrator', topics: [need('landscape', 3), need('backup', 3), need('access', 3), need('incidents'), need('changes')] },
      { job_role: 'IT service manager', topics: [need('incidents', 3), need('changes', 3), need('vendors', 3), need('landscape')] },
    ],
  },
  {
    key: 'finance',
    name: 'Finance and accounting',
    summary: 'Closing the books and paying on time.',
    topics: [
      { key: 'close', name: 'Month-end close', description: 'The steps of the close, their order and who does them.' },
      { key: 'payables', name: 'Supplier invoices and payments', description: 'How invoices are checked, approved and paid.' },
      { key: 'receivables', name: 'Customer invoicing and collection', description: 'How invoices are raised and overdue items followed up.' },
      { key: 'reconciliations', name: 'Reconciliations', description: 'Which accounts are reconciled, how, and typical differences.' },
      { key: 'reporting', name: 'Reports and deadlines', description: 'Regular reports, their recipients and deadlines.' },
      { key: 'approvals', name: 'Approval limits', description: 'Who may approve what, and how exceptions are handled.' },
    ],
    roles: [
      { job_role: 'Accountant', topics: [need('close', 3), need('payables'), need('receivables'), need('reconciliations', 3)] },
      { job_role: 'Finance manager', topics: [need('close', 3), need('reporting', 3), need('approvals', 3)] },
    ],
  },
  {
    key: 'human-resources',
    name: 'Human resources',
    summary: 'Hiring, onboarding and looking after employment matters.',
    topics: [
      { key: 'hiring', name: 'Hiring process', description: 'From vacancy to offer: steps, templates and who decides.' },
      { key: 'onboarding', name: 'Onboarding and offboarding', description: 'What a joiner or leaver needs, in which order.' },
      { key: 'payroll', name: 'Payroll inputs', description: 'What must reach payroll, by when, and common errors.' },
      { key: 'absence', name: 'Absence and leave', description: 'Rules for holidays, sickness and other leave.' },
      { key: 'training', name: 'Mandatory training', description: 'Which training is required for whom, and when it expires.' },
      { key: 'agreements', name: 'Company agreements and policies', description: 'Local agreements and where the current versions are.' },
    ],
    roles: [
      { job_role: 'HR officer', topics: [need('hiring'), need('onboarding', 3), need('payroll', 3), need('absence', 3), need('training')] },
      { job_role: 'HR manager', topics: [need('hiring', 3), need('agreements', 3), need('training')] },
    ],
  },
];

export const findTemplate = (key: string): DepartmentTemplate | undefined => DEPARTMENT_TEMPLATES.find((t) => t.key === key);

/** Every role refers only to topics of its own template, and keys are unique: checked by a unit test. */
export function templateProblems(templates: readonly DepartmentTemplate[] = DEPARTMENT_TEMPLATES): string[] {
  const problems: string[] = [];
  const keys = new Set<string>();
  for (const t of templates) {
    if (keys.has(t.key)) problems.push(`duplicate template key ${t.key}`);
    keys.add(t.key);
    const topicKeys = new Set(t.topics.map((x) => x.key));
    if (topicKeys.size !== t.topics.length) problems.push(`${t.key}: duplicate topic key`);
    if (new Set(t.topics.map((x) => x.name.toLowerCase())).size !== t.topics.length) problems.push(`${t.key}: duplicate topic name`);
    for (const topic of t.topics) {
      if (topic.name.length < 1 || topic.name.length > 120 || topic.description.length > 1000) problems.push(`${t.key}/${topic.key}: name or description too long`);
    }
    for (const r of t.roles) {
      for (const link of r.topics) if (!topicKeys.has(link.key)) problems.push(`${t.key}/${r.job_role}: unknown topic ${link.key}`);
    }
  }
  return problems;
}

// Checked at load, not only by a test: a template that refers to a topic it does not have must never be applied.
const loadProblems = templateProblems();
if (loadProblems.length > 0) throw new Error(`department templates are inconsistent: ${loadProblems.join('; ')}`);
