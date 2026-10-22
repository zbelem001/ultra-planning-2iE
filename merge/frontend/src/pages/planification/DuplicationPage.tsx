import { useState } from 'react';
import { useCurrentUser } from '../../auth/AuthContext';
import { EmptyState, PageHeader, StatCard } from '../../components/ui';
import { anomalies } from '../../lib/contraintes';
import { formatDateTime } from '../../lib/helpers';
import {
  ajouterJours,
  derniereDuplication,
  dureeHeures,
  formatDateCourte,
  heuresPrevues,
  libelleSemestre,
  occurrences,
  semainesDuSemestre,
  semestreActif,
} from '../../lib/planning';
import { byId, useData } from '../../store/DataContext';

// Page 17 — Duplication de la semaine type sur toute la période du semestre (BF-14).
// Chaque série (cours, type, groupe) s'arrête quand son volume prévu est atteint
// (CD-08) ; chaque date tombe le jour de son créneau, dans le semestre (CD-09).

export default function DuplicationPage() {
  const user = useCurrentUser();
  const { db, save } = useData();
  const ouverts = db.semestres.filter((s) => s.statut !== 'cloturee');
  const [semestreId, setSemestreId] = useState(semestreActif(db)?.id ?? ouverts[0]?.id);
  const semestre = db.semestres.find((s) => s.id === semestreId);
  const [exclues, setExclues] = useState<string[]>(() => (semestre ? (derniereDuplication(db, semestre.id)?.semainesExclues ?? []) : []));
  const [fait, setFait] = useState<string | null>(null);

  if (!semestre) {
    return (
      <>
        <PageHeader title="Dupliquer la semaine type" refs="BF-14" />
        <EmptyState>Aucun semestre ouvert. Ouvrez-en un dans « Années universitaires ».</EmptyState>
      </>
    );
  }

  const semaines = semainesDuSemestre(semestre);
  const occ = occurrences(db, db.seances, semestre, exclues);
  const nbCours = semaines.length - exclues.length;
  const creneaux = byId(db.creneaux);
  const cours = byId(db.cours);
  const types = byId(db.typesSeance);
  const groupes = byId(db.groupes);
  const derniere = derniereDuplication(db, semestre.id);
  const enAnomalie = anomalies(db).length;

  // Bilan par série
  const series = new Map<string, { coursId: number; typeSeanceId: number; groupeId: number; hebdo: number; planifie: number; derniere?: string }>();
  for (const s of db.seances) {
    const cle = `${s.coursId}-${s.typeSeanceId}-${s.groupeId}`;
    const x = series.get(cle) ?? { coursId: s.coursId, typeSeanceId: s.typeSeanceId, groupeId: s.groupeId, hebdo: 0, planifie: 0 };
    x.hebdo += dureeHeures(creneaux.get(s.creneauId)!);
    series.set(cle, x);
  }
  for (const o of occ) {
    const x = series.get(`${o.seance.coursId}-${o.seance.typeSeanceId}-${o.seance.groupeId}`)!;
    x.planifie += dureeHeures(creneaux.get(o.seance.creneauId)!);
    x.derniere = o.date;
  }
  const bilan = [...series.values()].map((x) => ({ ...x, prevu: heuresPrevues(db, x.coursId, x.typeSeanceId) }));
  const incompletes = bilan.filter((x) => x.planifie < x.prevu).length;

  function basculer(lundi: string) {
    setFait(null);
    setExclues((e) => (e.includes(lundi) ? e.filter((x) => x !== lundi) : [...e, lundi].sort()));
  }

  function dupliquer() {
    save('duplications', { id: 0, semestreId: semestre!.id, date: new Date().toISOString(), auteurId: user.id, semainesExclues: exclues, occurrences: occ.length });
    setFait(`${occ.length} séances datées générées sur ${nbCours} semaines.`);
  }

  return (
    <>
      <PageHeader
        title="Dupliquer la semaine type"
        description="La semaine type de la grille est répétée sur chaque semaine de cours du semestre."
        refs="BF-14 · CD-08, CD-09"
      />

      <div className="toolbar">
        <label htmlFor="dup-semestre">Semestre</label>
        <select
          id="dup-semestre"
          className="input"
          value={semestreId}
          onChange={(e) => {
            const id = Number(e.target.value);
            setSemestreId(id);
            setExclues(derniereDuplication(db, id)?.semainesExclues ?? []);
            setFait(null);
          }}
        >
          {ouverts.map((s) => (
            <option key={s.id} value={s.id}>
              {libelleSemestre(db, s)} · {formatDateCourte(s.debut)} → {formatDateCourte(s.fin)}
            </option>
          ))}
        </select>
      </div>

      <div className="grid-4">
        <StatCard label="Séances de la semaine type" value={db.seances.length} />
        <StatCard label="Semaines de cours" value={`${nbCours} / ${semaines.length}`} hint={`${exclues.length} semaine(s) exclue(s)`} />
        <StatCard label="Séances datées" value={occ.length} />
        <StatCard label="Séries incomplètes" value={incompletes} hint="Volume prévu non atteint sur le semestre" />
      </div>

      {enAnomalie > 0 && (
        <p className="notice">
          {enAnomalie} séance(s) de la semaine type violent une contrainte dure : corrigez-les dans la grille avant de publier.
        </p>
      )}

      <div className="grid-2 dup-layout">
        <section className="card">
          <h2>Semaines du semestre</h2>
          <p className="muted small">Décochez les semaines sans cours (vacances, examens).</p>
          <ul className="week-list">
            {semaines.map((lundi, i) => (
              <li key={lundi}>
                <label className="checkbox">
                  <input type="checkbox" checked={!exclues.includes(lundi)} onChange={() => basculer(lundi)} />
                  <span>
                    <strong>S{i + 1}</strong> · {formatDateCourte(lundi)} → {formatDateCourte(ajouterJours(lundi, 5))}
                  </span>
                </label>
              </li>
            ))}
          </ul>
        </section>

        <section className="card">
          <h2>Heures planifiées par série</h2>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Cours</th>
                  <th>Groupe</th>
                  <th className="num">Hebdo</th>
                  <th className="num">Planifié / prévu</th>
                  <th>État</th>
                </tr>
              </thead>
              <tbody>
                {bilan.map((x) => (
                  <tr key={`${x.coursId}-${x.typeSeanceId}-${x.groupeId}`}>
                    <td>
                      {cours.get(x.coursId)?.code} <span className="badge">{types.get(x.typeSeanceId)?.code}</span>
                    </td>
                    <td>{groupes.get(x.groupeId)?.code}</td>
                    <td className="num">{x.hebdo} h</td>
                    <td className="num">
                      {x.planifie} / {x.prevu} h
                    </td>
                    <td>
                      {x.prevu === 0 ? (
                        <span className="badge badge-danger">Aucun volume (CD-08)</span>
                      ) : x.planifie < x.prevu ? (
                        <span className="badge badge-warn">Manque {x.prevu - x.planifie} h</span>
                      ) : (
                        <span className="badge badge-ok">Complet{x.derniere ? ` le ${formatDateCourte(x.derniere)}` : ''}</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      </div>

      <div className="form-actions sticky-actions">
        {fait && (
          <span className="text-success" role="status">
            {fait}
          </span>
        )}
        {derniere && !fait && <span className="muted small">Dernière duplication : {formatDateTime(derniere.date)}</span>}
        <button className="btn btn-primary" onClick={dupliquer} disabled={nbCours === 0}>
          Dupliquer sur {nbCours} semaine(s)
        </button>
      </div>
    </>
  );
}
