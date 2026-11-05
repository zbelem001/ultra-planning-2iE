// Liste des salles de l'établissement (Salles > Salles libres > Lancer la recherche) -> brut/salles.json
import puppeteer from 'puppeteer-core'
import fs from 'node:fs'
const pause = (ms) => new Promise((r) => setTimeout(r, ms))
const navigateur = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox'] })
const page = await navigateur.newPage()
await page.setViewport({ width: 1400, height: 900 })
const reponses = []
page.on('response', async (r) => {
  if (!r.url().includes('appelfonction')) return
  try { reponses.push(JSON.parse(await r.text())) } catch {}
})
async function clicTexte(texte, filtre = () => true) {
  const boites = await page.evaluate((t) => [...document.querySelectorAll('*')]
    .filter((e) => e.childElementCount === 0 && e.innerText?.trim() === t)
    .map((e) => e.getBoundingClientRect()).filter((r) => r.width > 0)
    .map((r) => ({ x: r.x, y: r.y, w: r.width, h: r.height })), texte)
  const b = boites.find(filtre)
  if (!b) throw new Error(`Élément introuvable : ${texte} ${JSON.stringify(boites)}`)
  await page.mouse.click(b.x + b.w / 2, b.y + b.h / 2)
  await pause(2500)
}
await page.goto('https://svr-appweb.2ie-edu.org/hp/invite', { waitUntil: 'networkidle2', timeout: 60000 })
await pause(2000)
await clicTexte('Fermer')
await clicTexte('Salles')
await page.screenshot({ path: 'brut/menu_salles.png' })
await clicTexte('Salles libres', (b) => b.y > 90)
await page.screenshot({ path: 'brut/salles_libres.png' })
await clicTexte('Lancer la recherche')
await pause(3000)
const r = reponses.filter((x) => x.id === 'FonctionSallesLibres').at(-1)
if (r) fs.writeFileSync('brut/salles.json', JSON.stringify(r))
console.log(r ? 'salles.json écrit' : 'pas de réponse', reponses.map((x) => x.id))
await navigateur.close()
