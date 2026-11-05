// Détection d'un glisser-déposer sur une grille : par la position du pointeur et non par des zones
// de dépôt. Rien ne dépend donc de l'élément survolé : ni trous entre les créneaux, ni séance ou
// bandeau qui masquerait une zone. Les écouteurs sont sur le document le temps du glisser.

import { useEffect, useRef, type RefObject } from 'react'

const TOLERANCE = 24 // px autour de la grille où le pointeur compte encore
const ZONE_DEFILEMENT = 72 // px depuis le bord de l'écran ou de la grille
const VITESSE_MAX = 16 // px par image, tout près du bord

export interface RappelsGlisser {
  /** Le pointeur est sur la grille (ou tout près) */
  surPointeur: (x: number, y: number) => void
  /** Le pointeur a quitté la grille */
  surSortie: () => void
  surDepot: (x: number, y: number) => void
}

export function useSurfaceDepot(grille: RefObject<HTMLElement | null>, actif: boolean, rappels: RappelsGlisser) {
  const dernier = useRef(rappels)
  useEffect(() => { dernier.current = rappels })

  useEffect(() => {
    if (!actif) return
    let x = -1
    let y = -1
    let image = 0
    const surLaGrille = (px: number, py: number) => {
      const r = grille.current?.getBoundingClientRect()
      return !!r && px >= r.left - TOLERANCE && px <= r.right + TOLERANCE && py >= r.top - TOLERANCE && py <= r.bottom + TOLERANCE
    }
    const surDragOver = (e: DragEvent) => {
      if (e.clientX === 0 && e.clientY === 0) return // position inconnue (certains navigateurs)
      x = e.clientX
      y = e.clientY
      if (surLaGrille(x, y)) {
        e.preventDefault() // tout le survol accepte le dépôt : un refus s'explique après
        if (e.dataTransfer) e.dataTransfer.dropEffect = 'move'
        dernier.current.surPointeur(x, y)
      } else dernier.current.surSortie()
    }
    const surDrop = (e: DragEvent) => {
      if (!surLaGrille(e.clientX, e.clientY)) return
      e.preventDefault()
      dernier.current.surDepot(e.clientX, e.clientY)
    }
    // Défilement automatique près des bords : la page en hauteur, la grille en largeur
    const proportion = (avant: number, apres: number) =>
      avant < ZONE_DEFILEMENT ? -(ZONE_DEFILEMENT - avant) / ZONE_DEFILEMENT : apres < ZONE_DEFILEMENT ? (ZONE_DEFILEMENT - apres) / ZONE_DEFILEMENT : 0
    const defiler = () => {
      if (y >= 0) {
        const haut = proportion(y, window.innerHeight - y)
        if (haut) window.scrollBy(0, haut * VITESSE_MAX)
        const el = grille.current
        if (el && el.scrollWidth > el.clientWidth) {
          const r = el.getBoundingClientRect()
          const large = proportion(x - r.left, r.right - x)
          if (large) el.scrollLeft += large * VITESSE_MAX
        }
      }
      image = requestAnimationFrame(defiler)
    }
    document.addEventListener('dragover', surDragOver)
    document.addEventListener('drop', surDrop)
    image = requestAnimationFrame(defiler)
    return () => {
      document.removeEventListener('dragover', surDragOver)
      document.removeEventListener('drop', surDrop)
      cancelAnimationFrame(image)
    }
  }, [actif, grille])
}
