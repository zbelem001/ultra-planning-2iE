// Tous les cours de l'établissement, salle par salle, depuis l'espace invités HyperPlanning de 2iE.
// L'espace invités ne liste ni les promotions ni les enseignants, mais il donne toutes les salles
// (brut/salles.json, voir salles.mjs) : chaque cours ayant lieu dans une salle, l'emploi du temps des
// salles, semaine par semaine, contient tous les cours (sauf ceux qui n'ont pas de salle).
//
// Usage : node extraire_salles.mjs [--travailleurs 1] [--pause 3000] [--limite N] [--promotions brut/promotions.txt]
// Le site suspend l'adresse IP au-delà d'environ 1 000 requêtes en 20 minutes (2 navigateurs, 1,2 s entre les clics) :
// un seul navigateur et quelques secondes entre les clics par défaut.
// Avec --promotions : même extraction, promotion par promotion (noms exacts, un par ligne), dans brut/promotions/ :
// la vue d'une promotion contient aussi les séances de ses groupes et de ses options.
// Écrit brut/salles/NNN.json pour chaque salle : ses semaines (ListeCours, ListeAnnulationsCours). Chaque cours
// porte ses semaines (dom, indices depuis le premier lundi de l'année) : les dates n'en dépendent pas.
// Reprend là où il s'est arrêté : une salle déjà écrite n'est pas redemandée.
import puppeteer from 'puppeteer-core'
import fs from 'node:fs'

const arg = (nom, defaut) => { const i = process.argv.indexOf(`--${nom}`); return i > 0 ? Number(process.argv[i + 1]) : defaut }
const TRAVAILLEURS = arg('travailleurs', 1)
const PAUSE = arg('pause', 3000) // ms entre deux clics
const LIMITE = arg('limite', Infinity)
const URL = 'https://svr-appweb.2ie-edu.org/hp/invite'
const iPromo = process.argv.indexOf('--promotions')
const PROMOTIONS = iPromo > 0 ? process.argv[iPromo + 1] : null
const RUBRIQUE = PROMOTIONS ? { menu: 'Promotions', x: 117 } : { menu: 'Salles', x: 281 } // colonne du menu
const SORTIE = PROMOTIONS ? 'brut/promotions' : 'brut/salles'
const pause = (ms) => new Promise((r) => setTimeout(r, ms))
const normaliser = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim()
fs.mkdirSync(SORTIE, { recursive: true })

const salles = PROMOTIONS
  ? fs.readFileSync(PROMOTIONS, 'utf8').split('\n').filter((l) => l.trim()).map((nom, i) => ({ i, nom }))
  : JSON.parse(fs.readFileSync('brut/salles.json')).dataSec.data.listeSalles.V.map((s, i) => ({ i, nom: s.L }))
const aFaire = salles.filter((s) => !fs.existsSync(`${SORTIE}/${String(s.i).padStart(3, '0')}.json`)).slice(0, LIMITE)
console.log(`${salles.length} ${PROMOTIONS ? 'promotions' : 'salles'}, ${aFaire.length} à extraire, ${TRAVAILLEURS} navigateur(s)`)

async function travailleur(n, file) {
  let nav, page
  const reponses = []
  // Un navigateur neuf, sur la page d'accueil : au départ, et après une erreur (le site peut rester bloqué)
  async function ouvrir() {
    if (nav) await nav.close().catch(() => {})
    nav = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox'] })
    page = await nav.newPage()
    await page.setViewport({ width: 1400, height: 900 })
    page.on('response', async (r) => {
      if (!r.url().includes('appelfonction')) return
      try { reponses.push(JSON.parse(await r.text())) } catch { /* réponse non JSON */ }
    })
    await page.goto(URL, { waitUntil: 'networkidle2', timeout: 60000 })
    await pause(1500)
    await clicTexte('Fermer')
  }
  // Attend la prochaine réponse de ce type, après l'indice `depuis`
  const attendre = async (id, depuis, ms = 10000) => {
    for (let t = 0; t < ms; t += 150) {
      const r = reponses.slice(depuis).filter((x) => x.id === id).at(-1)
      if (r) return r
      await pause(150)
    }
    return null
  }
  // Les boutons du site ne réagissent qu'à de vrais clics de souris
  async function clicTexte(texte, filtre = () => true) {
    const boites = await page.evaluate((t) => [...document.querySelectorAll('*')]
      .filter((e) => e.childElementCount === 0 && e.innerText?.trim() === t)
      .map((e) => e.getBoundingClientRect()).filter((r) => r.width > 0)
      .map((r) => ({ x: r.x, y: r.y, w: r.width, h: r.height })), texte)
    const b = boites.find(filtre)
    if (!b) throw new Error(`élément introuvable : ${texte}`)
    await page.mouse.click(b.x + b.w / 2, b.y + b.h / 2)
    await pause(PAUSE)
  }

  await ouvrir()
  if (n === 0 && !PROMOTIONS) fs.writeFileSync('brut/parametres_salles.json', JSON.stringify(reponses.find((r) => r.id === 'FonctionParametres')))

  for (let s = file.shift(); s; s = file.shift()) {
    const debut = Date.now()
    try {
      await clicTexte(RUBRIQUE.menu)
      await clicTexte('en liste', (b) => Math.abs(b.x - RUBRIQUE.x) < 30)
      const champ = await page.evaluate(() => {
        const i = [...document.querySelectorAll('input')].find((e) => { const r = e.getBoundingClientRect(); return r.width > 80 && r.y > 100 && r.y < 300 })
        if (!i) return null
        const r = i.getBoundingClientRect()
        return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
      })
      if (!champ) throw new Error('champ de saisie introuvable')
      const avant = reponses.length
      await page.mouse.click(champ.x, champ.y)
      await page.keyboard.type(s.nom, { delay: 25 })
      await pause(1500)
      await page.keyboard.press('Enter')
      const presence = await attendre('FonctionDomaineDePresence', avant)
      const choisie = presence?.dataSec?.data?.listeRessources?.V?.[0]?.L
      if (!choisie || normaliser(choisie) !== normaliser(s.nom)) throw new Error(`trouvé : ${choisie ?? 'rien'}`)
      // La semaine affichée à l'ouverture (la semaine courante) n'est pas une case comme les autres dans la barre
      const affichee = (await attendre('FonctionEmploiDuTemps', avant))?.dataSec?.data

      // Cases de la barre des semaines : la ligne qui a le plus de numéros
      const cases = await page.evaluate(() => {
        // par les nœuds de texte : la semaine affichée est mise en forme autrement que les autres
        const n = []
        const marcheur = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
        for (let t = marcheur.nextNode(); t; t = marcheur.nextNode()) {
          if (!/^\d{1,2}$/.test(t.textContent.trim())) continue
          const r = t.parentElement.getBoundingClientRect()
          if (r.width > 0 && r.y > 130 && r.y < 240) n.push({ n: t.textContent.trim(), r })
        }
        const lignes = {}
        for (const x of n) (lignes[Math.round(x.r.y / 6)] ??= []).push({ n: x.n, x: x.r.x + x.r.width / 2, y: x.r.y + x.r.height / 2 })
        return Object.values(lignes).sort((a, b) => b.length - a.length)[0] ?? []
      })
      const semaines = [{ barre: 'affichee', ListeCours: affichee?.ListeCours ?? null, ListeAnnulationsCours: affichee?.ListeAnnulationsCours ?? null }]
      for (const c of cases) {
        const ici = reponses.length
        await page.mouse.click(c.x, c.y)
        const edt = await attendre('FonctionEmploiDuTemps', ici)
        await pause(PAUSE)
        const d = edt?.dataSec?.data
        semaines.push({ barre: c.n, ListeCours: d?.ListeCours ?? null, ListeAnnulationsCours: d?.ListeAnnulationsCours ?? null })
      }
      const cours = semaines.reduce((a, w) => a + (w.ListeCours?.length ?? 0), 0)
      fs.writeFileSync(`${SORTIE}/${String(s.i).padStart(3, '0')}.json`, JSON.stringify({ [PROMOTIONS ? 'promotion' : 'salle']: s.nom, semaines }))
      console.log(`[${n}] ${s.nom} : ${semaines.length} semaines, ${cours} cours (${((Date.now() - debut) / 1000).toFixed(0)} s)`)
    } catch (e) {
      if (/suspendue/i.test(await page.evaluate(() => document.body.innerText).catch(() => ''))) {
        console.log(`[${n}] le site a suspendu l'adresse IP : arrêt`)
        file.length = 0
        break
      }
      console.log(`[${n}] ${s.nom} : ÉCHEC ${e.message}`)
      fs.appendFileSync(`${SORTIE}/echecs.txt`, `${s.i};${s.nom};${e.message}\n`)
      await ouvrir().catch((e2) => console.log(`[${n}] réouverture impossible : ${e2.message}`))
    }
  }
  await nav.close()
}

const file = [...aFaire]
await Promise.all(Array.from({ length: Math.min(TRAVAILLEURS, file.length) }, (_, n) => travailleur(n, file)))
console.log('terminé')
