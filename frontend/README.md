# UltraPlanning 2iE · frontend

Interface web de planification des cours (voir `../fichier.md`). Deux modes :
- **simulé** (par défaut) : données fictives fidèles au schéma `../migrations/schema_supabase.sql`, gardées dans le navigateur ;
- **connecté** : si `VITE_API_URL` désigne l'API (`../backend`), les données viennent de la base et chaque modification y est enregistrée.

```bash
npm install
npm run dev        # http://localhost:5173
npm run build
```

## Deux interfaces

| Route | Public | Contenu |
|---|---|---|
| `/` | Enseignants, étudiants (invités) | Consultation façon HyperPlanning : onglets Classes / Enseignants / Salles / Matières, filtre filière et groupe, types CM/TD/TP, vues Semaine, Jour, Liste, Semestre, export iCalendar, impression, lien partageable |
| `/admin` | Scolarité, administrateurs | Tableau de bord, planification par glisser-déposer, disponibilités, génération, assistant IA, publication, référentiel |

La connexion admin est simulée (le SSO / CAS remplacera l'écran `/admin/connexion`).

## Organisation

```
src/
  types/db.ts          Types TS : une interface par table SQL, noms de colonnes identiques
  data/mock.ts         Jeu de test du script SQL (sections 8 et 9) + séances datées générées
  lib/rules.ts         Contrôle CD-01 à CD-11 (copie du déclencheur verifier_seance)
  lib/generator.ts     Générateur glouton de démonstration (remplacé plus tard par OR-Tools CP-SAT)
  lib/store.tsx        Base partagée : simulée (localStorage) ou image de l'API
  lib/api.ts           Client de l'API (mode connecté)
  lib/queries.ts       Jointures utilisées par les vues
  components/          Kit d'interface (DESIGN.md) et composants d'emploi du temps
  pages/               Consultation (invité) et pages admin
```

## Mode connecté

```bash
cp .env.example .env.local     # VITE_API_URL=http://localhost:8000
npm run dev
```

L'API doit autoriser l'origine du frontend (`ULTRAPLANNING_ORIGINES`).

**École consultée par les invités** : `?ecole=CODE` dans l'adresse (par exemple `/?ecole=2IE`, à mettre en favori), sinon `VITE_ECOLE`, sinon la seule école active. Si plusieurs écoles utilisent la plateforme et qu'aucune n'est précisée, l'espace invités propose de choisir.

**Nouvelle école** : sa grille de créneaux et ses types de salle sont créés avec elle. À la première connexion, la console demande le premier semestre (`Demarrage.tsx`), puis s'ouvre.

**Comptes** : la page Référentiel > Utilisateurs liste les comptes de l'école. L'administrateur y invite ses planificateurs (e-mail avec un lien pour choisir le mot de passe), renvoie une invitation, modifie ou désactive un compte. En mode connecté, aucun compte ne se crée autrement.

**Publication** : le bouton Publier de la page Planification passe par l'API, qui prévient par e-mail les seuls enseignants concernés par un changement. L'historique et la restauration demandent aussi l'API (mode connecté).

**Import CSV** (Référentiel, bouton Importer ; gabarit par table avec le bouton Gabarit CSV) :
- les colonnes sont reconnues par leur libellé (« Code », « Effectif ») ou leur nom technique (`code_classe`), sans tenir compte des majuscules ni des accents ; une référence s'écrit par son code (« L2INFO » pour la classe) ; une colonne inconnue est ignorée et signalée ;
- une ligne déjà présente (même code, ou même clé : classe + groupe, classe + matière + semestre…, `cle` dans `config.tsx`) est **mise à jour** avec les cellules remplies ; les autres sont créées ;
- chaque ligne passe par les mêmes contrôles que la saisie ; le rapport donne les lignes créées, mises à jour et rejetées (avec le motif).

**Génération** (mode connecté) : à partir d'une semaine, pour tout l'établissement, une filière ou des classes choisies, jusqu'à la fin du semestre, pour une ou deux semaines, ou jusqu'à une date. Deux modes : recalculer les séances non verrouillées de la période, ou **compléter seulement** (les séances existantes restent, seules les heures manquantes sont ajoutées). Si la version courante est publiée, un bandeau propose de créer une version de travail.

**Espace invités léger** (connexions lentes, forfaits limités) :
- la console d'administration et le client Supabase ne sont téléchargés qu'à l'ouverture de `/admin` ; le jeu de test, qu'en mode simulé ; la bibliothèque Excel, qu'au clic sur l'export. Première visite : ≈ 170 Ko au total ;
- l'API compresse ses réponses et étiquette l'emploi du temps public (ETag) : tant que rien n'est publié ou modifié, une visite ne coûte qu'une réponse « 304 » vide. La page revérifie toutes les minutes et au retour sur l'onglet, et affiche les changements sans rechargement (la console fait de même avec sa propre image de la base) ;
- un service worker (`public/sw.js`, en production) garde les fichiers du site et le dernier emploi du temps sur l'appareil : visites suivantes quasi gratuites, consultation possible sans connexion (bandeau « Hors ligne ») ;
- pas de police monospace à télécharger (police système).

**Exports** (espace invités) : iCalendar, impression de la vue affichée, et Excel (feuille des séances du semestre et récapitulatif des heures par matière ; bibliothèque `exceljs`, chargée seulement au moment de l'export).

**Export PDF d'une classe** (espace invités, et Planification dans la console) : une page A4 paysage par semaine, avec la grille telle qu'à l'écran (couleurs, cartes, pause, jours fériés). On choisit la classe et un groupe, les semaines (« Semaine affichée », « Jusqu'à la fin », « Tout le semestre » ou de S… à S…), les séances (CM, TD, TP, examens et rattrapages), les matières, et ce que montrent les cartes (enseignant, salle et campus, séances annulées, semaines sans séance). L'en-tête de chaque page donne l'école, la classe, la semaine, la version (publiée pour les invités ; à jour, ou celle de l'historique, dans la console), les filtres et le numéro de page. Les pages sont rendues hors de l'écran (`components/timetable/ExportPdf.tsx`, mode `impression` de la grille), puis l'impression du navigateur en fait le PDF (« Enregistrer au format PDF ») : texte net, aucune bibliothèque de plus.

**Connexion** : avec `VITE_SUPABASE_URL` et `VITE_SUPABASE_PUBLISHABLE_KEY`, la console se connecte par e-mail et mot de passe (Supabase Auth). Les comptes sont créés par invitation depuis la console super admin (`../superadmin`) ; le lien de l'invitation mène à `/admin/connexion`, où la personne choisit son mot de passe. Sans ces variables, la connexion de développement (liste des comptes) demande une API lancée avec `ULTRAPLANNING_AUTH_DEV=1`.

Le front ne lit et n'écrit qu'à travers `useStore()` (`lib/store.tsx`) :
- **Lecture** : l'invité reçoit l'image publique (version publiée seulement), un gestionnaire connecté l'image complète.
- **Écriture** : chaque `mutate()` calcule la différence avec l'état précédent (par clé primaire) et l'envoie à `POST /api/base/sync`. Si la base la refuse, le motif s'affiche et l'état réel est rechargé. Les contrôles de `lib/rules.ts` expliquent un refus avant l'écriture ; la base reste l'arbitre final.
- **Génération** : le solveur (moteur v3) tourne sur le serveur, sur une filière ou tout l'établissement, de la semaine choisie à la fin du semestre. On voit les heures placées, les heures non placées et leur motif, et un aperçu semaine par semaine avant d'appliquer. La carte **Règles du planificateur** saisit des règles sans toucher au code (interdire une fenêtre à une classe, un enseignant ou un cours ; finir une matière avant une autre ; plafond d'heures par jour).
- **Référentiel, règles 2iE** : site des cours d'une classe, groupes de type option et groupe parent (demi-groupe de TP dans son TD), cours mutualisés, types de salle acceptés, salles réservées, trajets entre sites. Les contrôles de la console (glisser-déposer) appliquent les mêmes règles que la base.
- **Glisser une séance vers une autre semaine (Planification)** : pendant un glisser, une bande apparaît à gauche et à droite de la grille. La séance (ou une séance type du panneau « Cours à placer ») gardée 0,7 s sur une bande fait passer à la semaine précédente ou suivante, puis une de plus toutes les 1,1 s ; on la lâche ensuite sur la grille de la nouvelle semaine. Lâchée sur une bande, rien ne bouge (`components/timetable/WeekGrid.tsx`).
- **Sélectionner plusieurs séances et les supprimer (Planification)** : Ctrl+clic (Cmd+clic sur Mac, ou Maj+clic) ajoute une séance à la sélection ou l'en retire ; Ctrl+A sélectionne toute la semaine affichée ; Échap désélectionne tout. Le menu du clic droit le propose aussi (« Ajouter à la sélection »). Les cartes sélectionnées sont encadrées et cochées, et la barre au-dessus de la grille en donne le nombre avec un bouton « Supprimer ». Suppr (ou ce bouton, ou « Supprimer les N séances » du clic droit) ouvre une confirmation qui liste les séances. Un examen ne part pas sans son rattrapage (sélectionner les deux). La notification propose « Annuler », qui remet les séances à l'identique si leurs créneaux sont toujours libres. La sélection appartient à la semaine où elle a été faite : sur une autre semaine, rien n'est sélectionné. Un clic simple ouvre toujours le détail ; son bouton « Supprimer » passe par le même chemin (avec « Annuler »).
- **Cours mutualisé sur les cartes** : les classes s'affichent l'une sous l'autre, une par ligne, chacune avec son icône. Quand la carte est trop courte pour toutes, la dernière ligne visible se termine par « +2 » (classes cachées), et l'info-bulle donne la liste complète. Sur la carte, la salle passe d'abord, puis les classes, puis l'enseignant : sur une carte courte, c'est l'enseignant qui disparaît en premier (il reste au clic).
- **Campus sur les cartes** : la ligne de la salle d'une séance donne aussi son campus, en court (« Salle F1 · Kamboinsé ») ; le nom complet est dans l'info-bulle et le détail. Partout où une grille s'affiche : Planification, espace invités. Sur une carte étroite, le texte s'arrête avant les petits « + » et « − ».
- **Allonger ou raccourcir une séance (Planification)** : petits « + » et « − » en bas à droite d'une séance déplaçable. Chacun ne s'affiche que si l'heure en plus ou en moins passerait : la nouvelle fin est une fin de créneau du jour, sans franchir de pause, la durée reste entre 2 h et 5 h (3 h pour une épreuve) et aucune règle n'est enfreinte (salle, enseignant, classe, volume, rythme de la semaine...). Pour le « + », si seule la salle est prise sur l'heure en plus, la plus petite salle libre qui convient la remplace (l'info-bulle le dit). Les boutons se recalculent à chaque modification : raccourcir une séance peut rendre possible l'allongement d'une autre du même cours. Le changement est enregistré en base comme toute modification, « Cours à placer » se met à jour, et la notification propose « Annuler ».
- **Copier-coller une séance (Planification)** : clic droit sur une séance (Copier, Dupliquer la semaine suivante, Ouvrir la séance), ou Ctrl+C sur la séance survolée. La séance copiée est encadrée en pointillé et reste en mémoire d'une page à l'autre. Ctrl+V la colle au créneau sous le pointeur (sinon au même jour et à la même heure dans la semaine affichée) ; clic droit sur une case : « Coller ». La copie passe les mêmes règles qu'une séance déposée : même salle si elle est libre, sinon la plus ajustée ; si seul l'enseignant est pris ou absent, la copie est posée sans enseignant (à désigner) ; volume du cours, rythme de la semaine, classe ou salle occupée : refusée, avec le motif.
- **Examens et rattrapages (Planification)** : on sélectionne 2 à 4 h à la souris sur une case vide (la sélection s'arrête à 4 h et à la pause), puis clic droit : séance de cours, examen ou rattrapage. Une séance de cours propose l'enseignant prévu et la plus petite salle libre qui convient, et affiche les règles qui la bloquent ; une épreuve est ramenée à 3 h au plus, ou le bouton « Programmer une épreuve » ; la fenêtre (`components/timetable/DialogEpreuve.tsx`) propose le cours, le campus et les salles libres, avec les places restantes quand une autre classe y compose déjà. Les règles sont dans `lib/rules.ts`, alignées sur la base.
- **Planification, deux vues** : « À jour », la seule version modifiable, avec le bouton Publier et le nombre de modifications non publiées ; « Historique », la liste des versions jusqu'à la première, leur grille en lecture seule et la restauration avec aperçu et confirmation (`components/timetable/HistoriqueVersions.tsx`). Les invités voient la dernière publication.
- **Espace invités en un bloc** : à partir de 1024 px de large, la page ne défile plus. Les filtres tiennent sur une ligne, et le titre, les semaines et les outils sur une autre ; la grille ajuste ses heures à la place qui reste (36 px par heure au moins) et chaque carte n'affiche que ce qui y tient, le détail complet restant au clic. La liste et le semestre défilent dans le bloc. Sur téléphone et tablette, la page défile comme avant.
- **Disponibilités** : la grille montre toutes les heures, comme un emploi du temps ; celles sans créneau (pause déjeuner, samedi après-midi) sont grisées et ne se déclarent pas.
- **Filtres de la console** (`lib/filtres.ts`) : Planification (classe, enseignant ou salle, groupe, semaine) et Disponibilités (enseignant) s'ouvrent sans rien de choisi ; rien ne se programme tant qu'aucun filtre n'est choisi. Le choix reste en place d'une page à l'autre et après un rechargement, jusqu'à ce qu'on le change ; une nouvelle session repart sans filtre.
- **Planification en un bloc** : à partir de 1280 px de large, la page ne défile plus. La grille ajuste ses heures à la place qui reste (36 px par heure au moins) et chaque carte n'affiche que ce qui y tient ; les colonnes « Cours à placer » et « Versions » défilent dans leur propre hauteur. En dessous, la page défile comme avant.
- **Performances sur une vraie base (plus de 4 000 séances)** : une modification ne copie que les tables qu'elle lit, et les lignes inchangées gardent leur objet (`brouillonDe` et `partager`, `lib/store.tsx`). Les calculs qui dépendent d'une table inchangée ne se refont donc pas, et `enrichir` (`lib/queries.ts`) ne refait que les séances changées. `checkSeance` (`lib/rules.ts`) range les séances par date, par cours et par semaine une fois par liste, au lieu de tout relire pour chaque salle, chaque enseignant ou chaque créneau testé. Le Tableau de bord passait ainsi de 64 s à 0,35 s pour compter les séances en infraction. Le panneau « Cours à placer » se calcule en un passage, et seules ses lignes qui changent se redessinent (`components/timetable/LigneAPlacer.tsx`).
- **Détail d'une séance (Planification)** : « Changer de salle » ne montre que les salles libres à son horaire, du type exigé, assez grandes quand l'effectif de la classe est renseigné, et sur un campus où ses étudiants n'ont pas déjà cours autre part cette demi-journée (`sallesLibresSeance`, `lib/rules.ts`). Les salles du campus mère passent d'abord ; celles de l'autre campus portent son nom. Une salle sans capacité connue affiche « capacité ? ». « Classes qui suivent ce cours » mutualise le cours avec d'autres classes (recherche, ajout, retrait) : toutes ses séances entrent aussitôt dans leur emploi du temps de travail, et dans l'espace invités à la publication suivante (le bouton Publier compte ces changements ; `vueInvites`, `lib/versions.ts`). Une classe déjà occupée à l'heure d'une de ces séances, ou dont l'effectif ne tiendrait pas dans une salle, est en rouge avec la raison et ne peut pas être choisie (`lib/mutualisation.ts`).
- **Annuler une séance** : depuis le clic droit sur la séance ou son détail ; la notification propose « Rétablir ». Ses heures redeviennent à placer : « Cours à placer » les compte et l'indique (« dont 2 h de séances annulées, à replacer »), comme la base et la génération.
- **Cours à placer (Planification)** : les cours qui ont encore des heures à placer sont en haut ; ceux dont le volume est atteint sont regroupés en bas, sous « Volume atteint ». Chaque cours propose toutes les durées d'une séance, de 2 à 5 h (en foncé, celle des séances types du cours). Une séance de 5 h, une matinée entière, ne se pose qu'à la main : la génération s'arrête à 4 h. Elles se calculent sur ce qui reste (`lib/aPlacer.ts`) : le volume du cours et la place dans son maximum de la semaine, sans jamais laisser un reste inférieur à 2 h. Une durée qui ne tient pas reste visible, barrée, et son survol dit pourquoi.
- **Glisser-déposer (Planification)** : le créneau visé se déduit de la position du pointeur et de l'endroit où la séance a été saisie (`lib/glisser.ts`), et non de zones de dépôt. Un bloc en pointillé montre où la séance atterrit, avec sa salle ou le motif du refus. La validité des créneaux (`evaluerCreneau`, `lib/rules.ts`) contrôle une seule fois les règles sans rapport avec la salle, puis cherche une salle libre.
- **Assistant IA** : messages envoyés à l'API. L'assistant n'écrit rien lui-même : chaque proposition (séances, suppressions, épreuves, résultats du solveur, référentiel) s'affiche en carte « À valider » sous sa réponse, avec « Valider » et « Rejeter ». Validée, une proposition de séances s'écrit dans la version à jour (lien « voir et publier dans Planification »), puis se publie à la main depuis Planification. Des changements du référentiel suivis d'une génération : la génération est calculée à leur validation et apparaît comme une nouvelle carte à valider.
- **Réponses de l'assistant** : elles s'affichent au fur et à mesure qu'elles s'écrivent. Pendant l'attente, seul le vrai travail est annoncé (lecture, vérification, solveur).
- **Écran neutre** : en arrivant sur l'assistant ou en y revenant depuis une autre page, aucune discussion n'est ouverte ; les précédentes restent dans la colonne de gauche. Seule une discussion désignée dans l'adresse (`?c=`) s'ouvre d'elle-même, par exemple après un rechargement.
- **Suivi de la discussion** : à l'ouverture, à l'envoi et à la fin d'une réponse, la zone revient au dernier message, sans dépasser le début de la dernière réponse (une réponse plus haute que l'écran se lit depuis son début). Entre-temps, elle suit ce qui s'écrit, sauf si l'on est remonté lire plus haut.

En mode simulé, le générateur glouton (`lib/generator.ts`) tourne dans le navigateur, l'assistant répond par des règles simples, et le bouton « Réinitialiser » recharge le jeu de test.
