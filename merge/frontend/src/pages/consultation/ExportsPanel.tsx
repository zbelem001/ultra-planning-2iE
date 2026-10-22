import { useState } from 'react';
import type { Index } from '../../components/planning';
import { calendrierIcs, classeurXlsx, telecharger } from '../../lib/exports';
import { formatDateCourte, jourDeDate, type Occurrence } from '../../lib/planning';

// Page 23 — Exports de l'emploi du temps affiché (BF-22) : PDF par l'impression
// du navigateur, classeur Excel, fichier iCalendar et lien d'abonnement agenda.

export default function ExportsPanel({
  titre,
  fichier,
  abonnement,
  occurrences,
  index,
}: {
  titre: string;
  /** Nom de fichier sans extension. */
  fichier: string;
  abonnement: string;
  occurrences: Occurrence[];
  index: Index;
}) {
  const [copie, setCopie] = useState(false);
  const [fait, setFait] = useState<string | null>(null);

  const ligne = (o: Occurrence) => {
    const s = o.seance;
    const salle = index.salles.get(s.salleId);
    const ens = index.enseignants.get(s.enseignantId);
    return {
      cours: index.cours.get(s.coursId),
      type: index.types.get(s.typeSeanceId)?.code ?? '',
      groupe: index.groupes.get(s.groupeId)?.code ?? '',
      salle: salle?.code ?? '',
      batiment: index.batiments.get(salle?.batimentId ?? 0)?.code ?? '',
      enseignant: ens ? `${ens.prenom} ${ens.nom}` : '',
    };
  };

  function excel() {
    const lignes: (string | number)[][] = [['Date', 'Jour', 'Début', 'Fin', 'Code', 'Cours', 'Type', 'Groupe', 'Enseignant', 'Salle', 'Bâtiment']];
    for (const o of occurrences) {
      const l = ligne(o);
      lignes.push([o.date, jourDeDate(o.date) ?? '', o.debut, o.fin, l.cours?.code ?? '', l.cours?.intitule ?? '', l.type, l.groupe, l.enseignant, l.salle, l.batiment]);
    }
    telecharger(`${fichier}.xlsx`, classeurXlsx('Emploi du temps', lignes), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    setFait(`${occurrences.length} séances exportées vers Excel.`);
  }

  function ical() {
    const evenements = occurrences.map((o) => {
      const l = ligne(o);
      return {
        uid: `seance-${o.seance.id}-${o.date}`,
        date: o.date,
        debut: o.debut,
        fin: o.fin,
        titre: `${l.cours?.code} ${l.type} — ${l.cours?.intitule}`,
        lieu: `${l.salle} (bâtiment ${l.batiment})`,
        description: `Groupe ${l.groupe}\nEnseignant : ${l.enseignant}`,
      };
    });
    telecharger(`${fichier}.ics`, calendrierIcs(titre, evenements), 'text/calendar;charset=utf-8');
    setFait(`${occurrences.length} séances exportées au format iCalendar.`);
  }

  async function copier() {
    try {
      await navigator.clipboard.writeText(abonnement);
      setCopie(true);
      setTimeout(() => setCopie(false), 2000);
    } catch {
      setCopie(false);
    }
  }

  const periode = occurrences.length ? `du ${formatDateCourte(occurrences[0].date)} au ${formatDateCourte(occurrences[occurrences.length - 1].date)}` : '';

  return (
    <section className="card export-bar no-print" aria-labelledby="exports-titre">
      <div className="section-head">
        <h2 id="exports-titre">Exporter</h2>
        <span className="refs">BF-22</span>
      </div>
      <div className="shortcuts">
        <button className="btn" onClick={() => window.print()}>
          PDF (vue affichée)
        </button>
        <button className="btn" onClick={excel} disabled={occurrences.length === 0}>
          Excel (semestre)
        </button>
        <button className="btn" onClick={ical} disabled={occurrences.length === 0}>
          Fichier iCalendar (semestre)
        </button>
      </div>
      <p className="muted small">
        Excel et iCalendar contiennent les {occurrences.length} séances datées {periode}. Pour le PDF, choisissez « Enregistrer au format PDF » dans la fenêtre d’impression.
      </p>
      <div className="copy-row">
        <input className="input" readOnly value={abonnement} aria-label="Lien d’abonnement iCalendar" />
        <button className="btn" onClick={copier}>
          {copie ? 'Copié' : 'Copier le lien d’abonnement'}
        </button>
      </div>
      {fait && (
        <p className="text-success small" role="status">
          {fait}
        </p>
      )}
    </section>
  );
}
