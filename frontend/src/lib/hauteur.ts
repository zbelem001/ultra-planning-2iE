// Hauteur disponible entre le haut d'un élément et le bas de l'écran : pour qu'une grille ou une
// discussion occupe l'espace restant. Recalculée au redimensionnement et quand le contenu
// au-dessus change (bandeau, filtres sur deux lignes...).

import { useLayoutEffect, useRef, useState } from 'react'

export function useHauteurRestante<T extends HTMLElement>(marge = 24, minimum = 0) {
  const ref = useRef<T>(null)
  const [hauteur, setHauteur] = useState<number | null>(null)
  useLayoutEffect(() => {
    const mesurer = () => {
      const el = ref.current
      if (!el) return
      const haut = el.getBoundingClientRect().top + window.scrollY  // position dans la page, indépendante du défilement
      setHauteur(Math.max(minimum, Math.floor(window.innerHeight - haut - marge)))
    }
    mesurer()
    window.addEventListener('resize', mesurer)
    const observateur = new ResizeObserver(mesurer)
    observateur.observe(document.body)
    return () => { window.removeEventListener('resize', mesurer); observateur.disconnect() }
  }, [marge, minimum])
  return [ref, hauteur] as const
}
