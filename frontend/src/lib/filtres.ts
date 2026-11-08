// Filtres de la console (classe, enseignant, salle, groupe, semaine…) : ils restent en place quand on passe
// d'une page à l'autre, et après un rechargement, jusqu'à ce que l'administrateur les change. Propres à
// l'onglet et au compte : une nouvelle session repart sans filtre.

import { useCallback, useState } from 'react'
import { useSession } from './auth'

function lire<T>(cle: string): T | undefined {
  try {
    const v = sessionStorage.getItem(cle)
    return v === null ? undefined : (JSON.parse(v) as T)
  } catch {
    return undefined
  }
}

export function useFiltre<T>(nom: string, initial: T): [T, (v: T) => void] {
  const cle = `ultraplanning-filtre:${useSession() ?? 'anonyme'}:${nom}`
  const [valeur, setValeur] = useState<T>(() => lire<T>(cle) ?? initial)
  const changer = useCallback((v: T) => {
    setValeur(v)
    try {
      sessionStorage.setItem(cle, JSON.stringify(v))
    } catch {
      // stockage indisponible (navigation privée stricte) : le filtre vaut le temps de la page
    }
  }, [cle])
  return [valeur, changer]
}
