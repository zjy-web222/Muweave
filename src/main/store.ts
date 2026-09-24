import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { join, resolve, relative, isAbsolute } from 'node:path'
import { randomUUID } from 'node:crypto'
import {
  defaultConfig,
  configSchema,
  projectSchema,
  jobSchema,
  type Project,
  type Job,
  type Config,
  shotSchema,
} from '../shared/schema'

export function inside(root: string, file: string) {
  const target = resolve(root, file),
    rel = relative(root, target)
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new Error('无效的项目文件路径')
  return target
}
export class Store {
  db: DatabaseSync
  constructor(public root: string) {
    mkdirSync(root, { recursive: true })
    this.db = new DatabaseSync(join(root, 'director.sqlite'))
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS projects(id TEXT PRIMARY KEY, document TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS history(project_id TEXT, revision INTEGER, created TEXT, document TEXT, PRIMARY KEY(project_id,revision));
      CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY, document TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT NOT NULL);
      PRAGMA user_version=1;`)
  }
  projects(): Project[] {
    return this.db
      .prepare('SELECT document FROM projects ORDER BY rowid DESC')
      .all()
      .map((r) => projectSchema.parse(JSON.parse(String(r.document))))
  }
  project(id: string): Project {
    const row = this.db.prepare('SELECT document FROM projects WHERE id=?').get(id)
    if (!row) throw new Error('项目不存在')
    return projectSchema.parse(JSON.parse(String(row.document)))
  }
  save(p: Project, version = true) {
    projectSchema.parse(p)
    this.db.exec('BEGIN IMMEDIATE')
    try {
      if (version) {
        const old = this.db.prepare('SELECT document FROM projects WHERE id=?').get(p.id)
        if (old) {
          const prev = projectSchema.parse(JSON.parse(String(old.document)))
          this.db
            .prepare('INSERT OR IGNORE INTO history VALUES(?,?,?,?)')
            .run(p.id, prev.revision, prev.updatedAt, JSON.stringify(prev))
        }
        p.revision++
        p.updatedAt = new Date().toISOString()
      }
      this.db.prepare('INSERT OR REPLACE INTO projects VALUES(?,?)').run(p.id, JSON.stringify(p))
      this.db
        .prepare(
          'DELETE FROM history WHERE project_id=? AND revision NOT IN (SELECT revision FROM history WHERE project_id=? ORDER BY revision DESC LIMIT 100)',
        )
        .run(p.id, p.id)
      this.db.exec('COMMIT')
    } catch (e) {
      this.db.exec('ROLLBACK')
      throw e
    }
    return p
  }
  update(id: string, fn: (p: Project) => void, version = true) {
    const p = this.project(id)
    fn(p)
    return this.save(p, version)
  }
  dir(id: string) {
    const dir = inside(this.root, `projects/${id}`)
    mkdirSync(dir, { recursive: true })
    return dir
  }
  file(id: string, path: string) {
    return inside(this.dir(id), path)
  }
  get<T>(key: string, fallback: T): T {
    const row = this.db.prepare('SELECT value FROM settings WHERE key=?').get(key)
    return row ? JSON.parse(String(row.value)) : fallback
  }
  set(key: string, value: unknown) {
    this.db.prepare('INSERT OR REPLACE INTO settings VALUES(?,?)').run(key, JSON.stringify(value))
  }
  config(): Config {
    return configSchema.parse(this.get('config', defaultConfig))
  }
  jobs(): Job[] {
    return this.db
      .prepare('SELECT document FROM jobs ORDER BY rowid DESC LIMIT 2000')
      .all()
      .map((r) => jobSchema.parse(JSON.parse(String(r.document))))
  }
  job(id: string): Job {
    const row = this.db.prepare('SELECT document FROM jobs WHERE id=?').get(id)
    if (!row) throw new Error('任务不存在')
    return jobSchema.parse(JSON.parse(String(row.document)))
  }
  saveJob(j: Job) {
    j.updatedAt = new Date().toISOString()
    this.db
      .prepare('INSERT OR REPLACE INTO jobs VALUES(?,?)')
      .run(j.id, JSON.stringify(jobSchema.parse(j)))
  }
  history(id: string) {
    return this.db
      .prepare('SELECT revision,created FROM history WHERE project_id=? ORDER BY revision DESC')
      .all(id)
  }
  restore(id: string, revision: number) {
    const row = this.db
      .prepare('SELECT document FROM history WHERE project_id=? AND revision=?')
      .get(id, revision)
    if (!row) throw new Error('版本不存在')
    const p = projectSchema.parse(JSON.parse(String(row.document)))
    const current = this.project(id)
    p.media = current.media
    p.revision = current.revision
    return this.save(p)
  }
  close() {
    this.db.close()
  }
}
export function createProject(
  title: string,
  aspect: Project['aspect'],
  demo = false,
  locale: Config['locale'] = 'zh',
): Project {
  const pid = randomUUID(),
    ep = randomUUID(),
    now = new Date().toISOString()
  const p: Project = {
    id: pid,
    title,
    aspect,
    description: '',
    style: locale === 'en' ? 'Cinematic · Natural light · Realistic' : '电影感 · 自然光 · 写实',
    source: '',
    createdAt: now,
    updatedAt: now,
    revision: 0,
    episodes: [
      { id: ep, title: locale === 'en' ? 'Episode 1' : '第一集', script: '', scriptChat: [] },
    ],
    shots: [],
    assets: [],
    media: [],
    groups: [],
    layout: {},
  }
  if (demo) {
    p.description = '一封迟到的信，让两个人在雨夜重新相遇。'
    p.source =
      '深夜，林舟在即将关门的咖啡馆收到一封没有寄件人的信。信里只有一句话：如果你还记得，今晚十一点，老车站见。她穿过雨中的城市，在车站看到多年未见的陈默。'
    p.episodes[0] = { id: ep, title: '01 · 一封迟到的信', script: p.source, scriptChat: [] }
    p.assets = [
      {
        id: randomUUID(),
        kind: 'character',
        name: '林舟',
        description: '28 岁，短黑发，米色风衣。神情克制，眼神坚定。',
        prompt:
          'Cinematic portrait, woman with short black hair, beige trench coat, soft window light.',
      },
      {
        id: randomUUID(),
        kind: 'character',
        name: '陈默',
        description: '32 岁，深灰羊毛大衣，肩上沾着雨水。',
        prompt: 'Cinematic portrait, man in dark grey wool coat, rainy night.',
      },
      {
        id: randomUUID(),
        kind: 'location',
        name: '街角咖啡馆',
        description: '暖色灯光，木质吧台，落地玻璃上有雨水。',
        prompt: 'Empty warm coffee shop at midnight, wet window, cinematic lighting.',
      },
      {
        id: randomUUID(),
        kind: 'prop',
        name: '未署名的信',
        description: '米白色信封，折痕清晰，未署名。',
        prompt: 'Ivory envelope on a wooden table, close up, warm lamp.',
      },
    ]
    const scenes = [
      ['雨落街角', '雨水沿咖啡馆的玻璃滑落，远处的车灯划过街道。', '', '大全景', '缓慢推进', 6],
      [
        '未署名的信',
        '林舟用指尖展开信纸，停在最后一行。',
        '如果你还记得，今晚十一点。',
        '特写',
        '固定',
        5,
      ],
      ['决定出发', '她看向窗外，将信收进风衣口袋。', '这一次，我会去。', '近景', '缓慢推近', 5],
      ['穿过雨夜', '林舟撑伞走过湿漉漉的街道。', '', '全景', '跟拍', 6],
      ['十一点的车站', '陈默站在空荡的站台，向她转过身。', '你还是来了。', '中景', '横移', 5],
      [
        '迟到的重逢',
        '两人隔着几步距离，雨声渐渐变轻。',
        '这封信，你写了多久？',
        '双人近景',
        '固定',
        6,
      ],
    ] as const
    p.shots = scenes.map((s, i) =>
      shotSchema.parse({
        id: randomUUID(),
        episodeId: ep,
        title: s[0],
        action: s[1],
        dialogue: s[2],
        size: s[3],
        camera: s[4],
        duration: s[5],
        scene: i < 3 ? '街角咖啡馆' : '老车站',
        imagePrompt: `Cinematic storyboard, ${s[1]} Muted teal and warm amber, realistic, 35mm film.`,
        videoPrompt: `${s[1]} ${s[4]}，动作自然，保持人物服装一致。`,
        assetIds: i < 3 ? [p.assets[0].id, p.assets[2].id] : [p.assets[0].id, p.assets[1].id],
      }),
    )
  }
  return p
}
