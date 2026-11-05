// Extraction de l'emploi du temps d'une promotion depuis l'espace invités HyperPlanning de 2iE.
// Usage : node extraire.mjs "IA S9"   (texte de recherche : un seul résultat attendu, ici CYCLE ING IIA S9)
// Écrit dans brut/ : la réponse de l'emploi du temps de chaque semaine (FonctionEmploiDuTemps),
// les paramètres du site (premier lundi, grille) et la liste des salles (Salles libres).
import puppeteer from 'puppeteer-core'
import fs from 'node:fs'

const PROMOTION = process.argv[2] ?? 'IA S9'
const URL = 'https://svr-appweb.2ie-edu.org/hp/invite'
const pause = (ms) => new Promise((r) => setTimeout(r, ms))
fs.mkdirSync('brut', { recursive: true })

const navigateur = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox'] })
const page = await navigateur.newPage()
await page.setViewport({ width: 1400, height: 900 })

// Réponses de données (POST /hp/appelfonction/...), gardées dans l'ordre
const reponses = []
page.on('response', async (r) => {
  if (!r.url().includes('appelfonction')) return
  try { reponses.push(JSON.parse(await r.text())) } catch { /* réponse non JSON */ }
})
const derniere = (id) => reponses.filter((r) => r.id === id).at(-1)

// Les boutons du site ne réagissent qu'à de vrais clics de souris
async function clicTexte(texte, filtre = () => true) {
  const boites = await page.evaluate((t) => [...document.querySelectorAll('*')]
    .filter((e) => e.childElementCount === 0 && e.innerText?.trim() === t)
    .map((e) => e.getBoundingClientRect()).filter((r) => r.width > 0)
    .map((r) => ({ x: r.x, y: r.y, w: r.width, h: r.height })), texte)
  const b = boites.find(filtre)
  if (!b) throw new Error(`Élément introuvable : ${texte}`)
  await page.mouse.click(b.x + b.w / 2, b.y + b.h / 2)
  await pause(2500)
}

await page.goto(URL, { waitUntil: 'networkidle2', timeout: 60000 })
await pause(2000)
fs.writeFileSync('brut/parametres.json', JSON.stringify(derniere('FonctionParametres')))
await clicTexte('Fermer')

// Promotion, vue en liste
await clicTexte('Promotions')
await page.mouse.click(140, 172) // « en liste » du sous-menu Promotions
await pause(3000)
const champ = await page.evaluateHandle(() => document.elementFromPoint(270, 138))
await champ.click()
await page.keyboard.type(PROMOTION, { delay: 60 })
await pause(2500)
await page.keyboard.press('Enter')
for (let i = 0; i < 20 && !derniere('FonctionDomaineDePresence'); i++) await pause(500)
const presence = derniere('FonctionDomaineDePresence')
if (!presence) throw new Error(`Promotion introuvable : ${PROMOTION}`)
fs.writeFileSync('brut/presence.json', JSON.stringify(presence))

// Chaque semaine de la barre (numéros de semaine ISO, en haut de la liste)
const cases = await page.evaluate(() => [...document.querySelectorAll('*')]
  .filter((e) => e.childElementCount === 0 && /^\d{1,2}$/.test(e.innerText?.trim() ?? ''))
  .map((e) => ({ n: e.innerText.trim(), r: e.getBoundingClientRect() }))
  .filter((x) => x.r.y > 160 && x.r.y < 190 && x.r.width > 0)
  .map((x) => ({ n: x.n, x: x.r.x + x.r.width / 2, y: x.r.y + x.r.height / 2 })))
console.log(`${cases.length} semaines dans la barre`)
for (const c of cases) {
  const avant = reponses.length
  await page.mouse.click(c.x, c.y)
  await pause(2500)
  const edt = reponses.slice(avant).filter((r) => r.id === 'FonctionEmploiDuTemps').at(-1)
  const nb = edt?.dataSec?.data?.ListeCours?.length ?? 0
  if (edt) fs.writeFileSync(`brut/semaine_iso_${c.n.padStart(2, '0')}.json`, JSON.stringify(edt))
  console.log(`semaine ${c.n} : ${edt ? nb + ' cours' : 'pas de réponse'}`)
}
await page.screenshot({ path: 'brut/fin.png' })
await navigateur.close()
