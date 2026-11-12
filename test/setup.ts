// Chargé avant chaque fichier de test (voir le script "test").
// Les journaux informatifs du serveur sont coupés : écrits sur la sortie
// standard, ils se mélangent parfois au protocole interne du testeur de Node
// ("Unable to deserialize cloned data"). Les erreurs restent affichées.
console.log = () => {}
console.info = () => {}
console.warn = () => {}
