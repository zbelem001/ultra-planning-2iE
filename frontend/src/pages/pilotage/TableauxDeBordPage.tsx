import { useState } from 'react';
import { useCurrentUser } from '../../auth/AuthContext';
import { indexer, Jauge } from '../../components/planning';
import { EmptyState, PageHeader, StatCard, Tabs } from '../../components/ui';
import { demandes, departementDuGroupe, dureeHeures, heuresPrevues, libelleSemestre, nbSemainesEffectives, occurrences, parametres, semestreActif } from '../../lib/planning';
import { departementScope } from '../referentiel/scope';
import { useData } from '../../store/DataContext';

// Page 24 — Tableaux de bord (BF-23, BF-24), d'après la version de travail :
// heures planifiées face aux heures prévues, occupation des salles, charge des
// enseignants. Le chef de département ne voit que son département.
// Chaque jauge affiche sa valeur en clair ; le tableau sert de vue accessible.

type Onglet = 'heures' | 'salles' | 'enseignants';

export default function TableauxDeBordPage() {
  const user = useCurrentUser();
  const { db } = useData();
  const [onglet, setOnglet] = useState<Onglet>('heures');
  const [recherche, setRecherche] = useState('');
  const [seulementIncompletes, setSeulementIncompletes] = useState(false);
  const index = indexer(db);
  const semestre = semestreActif(db);
  const dep = departementScope(user);

  if (!semestre) return <EmptyState>Aucun semestre actif.</EmptyState>;

  const seances = db.seances.filter((s) => !dep || departementDuGroupe(db, s.groupeId) === dep);
  const occ = occurrences(db, seances, semestre);
  const h = (creneauId: number) => dureeHeures(index.creneaux.get(creneauId)!);

  // BF-23 — une ligne par séance attendue (programme × volume × groupe), plus les séries planifiées hors programme
  const lignes = new Map<string, { coursId: number; typeSeanceId: number; groupeId: number; planifie: number; prevu: number }>();
  for (const d of demandes(db, dep)) {
    lignes.set(`${d.coursId}-${d.typeSeanceId}-${d.groupeId}`, { ...d, planifie: 0, prevu: heuresPrevues(db, d.coursId, d.typeSeanceId) });
  }
  for (const o of occ) {
    const s = o.seance;
    const cle = `${s.coursId}-${s.typeSeanceId}-${s.groupeId}`;
    const l = lignes.get(cle) ?? { coursId: s.coursId, typeSeanceId: s.typeSeanceId, groupeId: s.groupeId, planifie: 0, prevu: heuresPrevues(db, s.coursId, s.typeSeanceId) };
    l.planifie += h(s.creneauId);
    lignes.set(cle, l);
  }
  const q = recherche.trim().toLowerCase();
  const heures = [...lignes.values()]
    .filter((l) => !seulementIncompletes || l.planifie < l.prevu)
    .filter((l) => !q || `${index.cours.get(l.coursId)?.code} ${index.cours.get(l.coursId)?.intitule} ${index.groupes.get(l.groupeId)?.code}`.toLowerCase().includes(q))
    .sort((a, b) => (index.cours.get(a.coursId)?.code ?? '').localeCompare(index.cours.get(b.coursId)?.code ?? '') || a.typeSeanceId - b.typeSeanceId);
  const totalPrevu = [...lignes.values()].reduce((t, l) => t + l.prevu, 0);
  const totalPlanifie = [...lignes.values()].reduce((t, l) => t + Math.min(l.planifie, l.prevu), 0);
  const completes = [...lignes.values()].filter((l) => l.prevu > 0 && l.planifie >= l.prevu).length;

  // BF-24 — occupation des salles sur la semaine type
  const creneauxOuverts = db.creneaux.filter((c) => !c.archived).length;
  const salles = db.salles
    .filter((s) => !s.archived)
    .map((salle) => {
      const ici = db.seances.filter((s) => s.salleId === salle.id);
      const remplissage = ici.length ? Math.round((ici.reduce((t, s) => t + (index.groupes.get(s.groupeId)?.effectif ?? 0) / salle.capacite, 0) / ici.length) * 100) : 0;
      return { salle, occupes: ici.length, taux: Math.round((ici.length / creneauxOuverts) * 100), remplissage };
    })
    .sort((a, b) => b.taux - a.taux);

  // BF-24 — charge des enseignants
  const max = parametres(db).heuresMaxJour;
  const nbSemaines = nbSemainesEffectives(db, semestre);
  const enseignants = db.enseignants
    .filter((e) => !e.archived && (!dep || e.departementId === dep))
    .map((e) => {
      const siennes = db.seances.filter((s) => s.enseignantId === e.id);
      const parJour = new Map<string, number>();
      for (const s of siennes) {
        const jour = index.creneaux.get(s.creneauId)!.jour;
        parJour.set(jour, (parJour.get(jour) ?? 0) + h(s.creneauId));
      }
      const semestreH = occurrences(db, siennes, semestre).reduce((t, o) => t + h(o.seance.creneauId), 0);
      return { e, hebdo: siennes.reduce((t, s) => t + h(s.creneauId), 0), semestreH, pic: Math.max(0, ...parJour.values()), cours: new Set(siennes.map((s) => s.coursId)).size };
    })
    .sort((a, b) => b.semestreH - a.semestreH);
  const maxSemestre = Math.max(1, ...enseignants.map((x) => x.semestreH));

  return (
    <>
      <PageHeader
        title="Tableaux de bord"
        description={`${libelleSemestre(db, semestre)} · ${nbSemaines} semaines de cours · version de travail${dep ? ` · département ${db.departements.find((d) => d.id === dep)?.code}` : ''}`}
        refs="BF-23, BF-24"
      />

      <div className="grid-4">
        <StatCard label="Heures planifiées / prévues" value={`${totalPrevu ? Math.round((totalPlanifie / totalPrevu) * 100) : 0} %`} hint={`${totalPlanifie} h sur ${totalPrevu} h`} />
        <StatCard label="Séries complètes" value={`${completes} / ${lignes.size}`} />
        <StatCard label="Occupation moyenne des salles" value={`${salles.length ? Math.round(salles.reduce((t, s) => t + s.taux, 0) / salles.length) : 0} %`} hint="Créneaux occupés sur la semaine type" />
        <StatCard label="Enseignants au-delà de la limite" value={enseignants.filter((x) => x.pic > max).length} hint={`Plus de ${max} h dans une journée (CS-06)`} />
      </div>

      <Tabs<Onglet>
        tabs={[
          { id: 'heures', label: 'Heures planifiées / prévues' },
          { id: 'salles', label: 'Occupation des salles' },
          { id: 'enseignants', label: 'Charge des enseignants' },
        ]}
        active={onglet}
        onChange={setOnglet}
      />

      {onglet === 'heures' && (
        <>
          <div className="toolbar">
            <input type="search" className="input search" placeholder="Cours ou groupe…" aria-label="Filtrer par cours ou groupe" value={recherche} onChange={(e) => setRecherche(e.target.value)} />
            <label className="checkbox">
              <input type="checkbox" checked={seulementIncompletes} onChange={(e) => setSeulementIncompletes(e.target.checked)} />
              Seulement les séries incomplètes
            </label>
            <span className="muted small toolbar-count">{heures.length} ligne(s)</span>
          </div>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Cours</th>
                  <th>Type</th>
                  <th>Groupe</th>
                  <th className="num">Planifié</th>
                  <th className="num">Prévu</th>
                  <th>Avancement</th>
                </tr>
              </thead>
              <tbody>
                {heures.map((l) => {
                  const pct = l.prevu ? Math.round((l.planifie / l.prevu) * 100) : 0;
                  return (
                    <tr key={`${l.coursId}-${l.typeSeanceId}-${l.groupeId}`}>
                      <td>
                        <strong>{index.cours.get(l.coursId)?.code}</strong> <span className="muted">{index.cours.get(l.coursId)?.intitule}</span>
                      </td>
                      <td>
                        <span className="badge">{index.types.get(l.typeSeanceId)?.code}</span>
                      </td>
                      <td>{index.groupes.get(l.groupeId)?.code}</td>
                      <td className="num">{l.planifie} h</td>
                      <td className="num">{l.prevu ? `${l.prevu} h` : '—'}</td>
                      <td>{l.prevu ? <Jauge valeur={pct} label={`${l.planifie} h planifiées sur ${l.prevu} h prévues`} /> : <span className="badge badge-danger">Aucun volume prévu</span>}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}

      {onglet === 'salles' && (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Salle</th>
                <th>Type</th>
                <th className="num">Capacité</th>
                <th className="num">Créneaux occupés</th>
                <th>Occupation</th>
                <th>Remplissage moyen</th>
              </tr>
            </thead>
            <tbody>
              {salles.map(({ salle, occupes, taux, remplissage }) => (
                <tr key={salle.id}>
                  <td>
                    <strong>{salle.code}</strong> <span className="muted">{salle.nom}</span>
                  </td>
                  <td>{db.typesSalle.find((t) => t.id === salle.typeSalleId)?.libelle}</td>
                  <td className="num">{salle.capacite}</td>
                  <td className="num">
                    {occupes} / {creneauxOuverts}
                  </td>
                  <td>
                    <Jauge valeur={taux} neutre label={`${salle.code} occupée ${occupes} créneaux sur ${creneauxOuverts}`} />
                  </td>
                  <td>{occupes ? <Jauge valeur={remplissage} neutre label="Effectif moyen rapporté à la capacité" /> : <span className="muted">—</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {onglet === 'enseignants' && (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Enseignant</th>
                <th>Grade</th>
                <th className="num">Cours</th>
                <th className="num">Heures / semaine</th>
                <th className="num">Journée la plus chargée</th>
                <th>Heures sur le semestre</th>
              </tr>
            </thead>
            <tbody>
              {enseignants.map(({ e, hebdo, semestreH, pic, cours }) => (
                <tr key={e.id}>
                  <td>
                    {e.prenom} {e.nom}
                  </td>
                  <td className="muted">{e.grade}</td>
                  <td className="num">{cours}</td>
                  <td className="num">{hebdo} h</td>
                  <td className="num">{pic > max ? <span className="badge badge-danger">{pic} h · au-delà de {max} h</span> : `${pic} h`}</td>
                  <td>
                    <Jauge valeur={semestreH} max={maxSemestre} unite="h" label={`${semestreH} h sur le semestre`} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
