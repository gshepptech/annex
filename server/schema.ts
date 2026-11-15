// The schema, one entry per version. A database is brought up to date by running the entries past
// its user_version in order, so an entry is never edited once released; changes go in a new one.

export const MIGRATIONS: string[] = [
  `
  create table wing (
    id text primary key,
    company_id text,
    mode text not null check (mode in ('with_you', 'autonomous')),
    -- doubles when back_off_when_idle is on and recent work moved no signal; 0 means none
    backoff_level integer not null default 0,
    held_until text,
    held_reason text,
    updated_at text not null
  );

  create table agent (
    id text primary key,
    wing_id text not null references wing(id),
    role text not null check (role in ('lead', 'worker', 'reviewer')),
    name text not null,
    desk integer not null,
    unique (wing_id, desk)
  );

  create table brief (
    id integer primary key,
    wing_id text not null references wing(id),
    version integer not null,
    text text not null,
    status text not null check (status in ('draft', 'approved', 'superseded')),
    approval_id text,
    created_at text not null,
    approved_at text,
    unique (wing_id, version)
  );

  create table check_run (
    id integer primary key,
    wing_id text not null references wing(id),
    task_id text not null,
    attempt integer not null,
    command text not null,
    cwd text not null,
    exit_code integer,
    output_tail text,
    started_at text not null,
    finished_at text
  );

  create table event (
    id integer primary key,
    wing_id text not null,
    at text not null,
    kind text not null,
    actor text not null,
    task_id text,
    payload text not null default '{}'
  );
  create index event_wing on event (wing_id, id);

  create table layout (
    wing_id text primary key,
    json text not null
  );

  create table chat (
    id integer primary key,
    wing_id text not null references wing(id),
    at text not null,
    who text not null check (who in ('you', 'lead')),
    text text not null
  );
  `,
  `
  alter table wing add column project_id text;
  alter table wing add column chat_issue_id text;

  -- tasks Annex created, with what the lead claimed for them, so the done check and the
  -- duplicate rule never depend on reading prose back out of Paperclip
  create table task (
    id text primary key,
    wing_id text not null references wing(id),
    identifier text not null,
    title text not null,
    done_check text not null,
    charter_line text,
    evidence text,
    source text not null check (source in ('lead', 'you')),
    state text not null default 'open' check (state in ('open', 'merged', 'stopped')),
    created_at text not null,
    closed_at text
  );

  create table drop_in (
    id integer primary key,
    wing_id text not null references wing(id),
    title text not null,
    detail text not null default '',
    created_at text not null,
    taken_at text
  );

  create table wake (
    id integer primary key,
    wing_id text not null references wing(id),
    issue_id text,
    started_at text not null,
    finished_at text,
    outcome text
  );
  `,
  `
  -- the Paperclip comment a chat line came from, so a reply is stored once however often it is seen
  alter table chat add column comment_id text;
  create unique index chat_comment on chat (comment_id) where comment_id is not null;
  `,
  `
  -- the signal output the lead was shown, so its proposal is judged against exactly that
  alter table wake add column signals text;
  `,
  `
  -- work the lead wants the person to say yes to first: a raised hand
  create table ask (
    id integer primary key,
    wing_id text not null references wing(id),
    task text not null,
    reason text not null,
    status text not null default 'pending' check (status in ('pending', 'approved', 'declined')),
    created_at text not null,
    decided_at text
  );
  `,
  `
  -- what the person wants an office to achieve; the lead keeps a plan for each and tasks name it
  create table goal (
    id integer primary key,
    wing_id text not null references wing(id),
    text text not null,
    done_when text,
    ongoing integer not null default 0,
    plan text not null default '',
    status text not null default 'active' check (status in ('active', 'done', 'dropped')),
    note text,
    created_at text not null,
    closed_at text
  );
  alter table task add column goal_id integer references goal(id);
  `,
  `
  -- folders the person added to their projects, wherever they are, and ones they asked Annex to
  -- stop listing (a ~/Projects repo or a folder a session ran in); the files are never touched
  create table project_folder (
    path text primary key,
    state text not null check (state in ('added', 'forgotten')),
    at text not null
  );
  `,
];
