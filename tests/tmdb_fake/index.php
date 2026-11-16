<?php
// Ersatz für TMDB im Test: liefert feste Antworten für die Testmedien und erzeugte Bilder.
// Start: php -S 0.0.0.0:80 tests/tmdb_fake/index.php
declare(strict_types=1);

$pfad = parse_url($_SERVER['REQUEST_URI'], PHP_URL_PATH);
$q = $_GET;

if (preg_match('#^/t/p/(w\d+|original)/(.+)$#', $pfad, $m)) {
    // Bild: einfarbig mit Text (GD)
    $png = str_ends_with($m[2], '.png');
    $b = (int) (substr($m[1], 1) ?: 500);
    $h = (int) ($b * 1.5);
    $img = imagecreatetruecolor($b, $h);
    $farbe = imagecolorallocate($img, (crc32($m[2]) >> 16) & 120, (crc32($m[2]) >> 8) & 160, 200);
    imagefill($img, 0, 0, $farbe);
    imagestring($img, 5, 10, 10, $m[2], imagecolorallocate($img, 255, 255, 255));
    header('Content-Type: ' . ($png ? 'image/png' : 'image/jpeg'));
    $png ? imagepng($img) : imagejpeg($img, null, 80);
    exit;
}

function antwort(array $d): never
{
    header('Content-Type: application/json');
    echo json_encode($d, JSON_UNESCAPED_UNICODE);
    exit;
}

if (empty($q['api_key']) && empty($_SERVER['HTTP_AUTHORIZATION'])) {
    http_response_code(401);
    antwort(['status_message' => 'no key']);
}

$filme = [
    24428 => ['title' => 'Marvel\'s The Avengers', 'original_title' => 'The Avengers', 'release_date' => '2012-04-25', 'runtime' => 143, 'coll' => 86311,
        'overview' => 'Die Rächer müssen zusammenarbeiten.', 'tagline' => 'Gemeinsam sind sie stark'],
    99861 => ['title' => 'Avengers: Age of Ultron', 'original_title' => 'Avengers: Age of Ultron', 'release_date' => '2015-04-22', 'runtime' => 141, 'coll' => 86311,
        'overview' => 'Ultron will die Menschheit auslöschen.', 'tagline' => ''],
    1001 => ['title' => 'Testfilm', 'original_title' => 'Test Movie', 'release_date' => '2024-01-10', 'runtime' => 95, 'coll' => null, 'overview' => '', 'tagline' => ''],
];

function norm(string $s): string
{
    return trim((string) preg_replace('/[^a-z0-9]+/', ' ', strtolower($s)));
}

if ($pfad === '/3/search/movie') {
    $wort = norm((string) ($q['query'] ?? ''));
    $treffer = [];
    foreach ($filme as $id => $f) {
        if (str_contains(norm($f['title']), $wort) || str_contains(norm($f['original_title']), $wort)) {
            if (empty($q['year']) || substr($f['release_date'], 0, 4) === (string) $q['year']) {
                $treffer[] = ['id' => $id, 'title' => $f['title'], 'original_title' => $f['original_title'], 'release_date' => $f['release_date'], 'poster_path' => "/p$id.jpg", 'overview' => $f['overview']];
            }
        }
    }
    antwort(['results' => $treffer]);
}
if (preg_match('#^/3/movie/(\d+)$#', $pfad, $m) && isset($filme[(int) $m[1]])) {
    $id = (int) $m[1];
    $f = $filme[$id];
    $en = ($q['language'] ?? '') === 'en-US';
    antwort(['id' => $id, 'title' => $f['title'], 'original_title' => $f['original_title'], 'release_date' => $f['release_date'], 'runtime' => $f['runtime'],
        'overview' => $en && $f['overview'] === '' ? 'An English fallback overview.' : $f['overview'], 'tagline' => $f['tagline'], 'imdb_id' => 'tt' . str_pad((string) $id, 7, '0', STR_PAD_LEFT),
        'vote_average' => 7.7, 'poster_path' => "/p$id.jpg", 'backdrop_path' => "/b$id.jpg",
        'belongs_to_collection' => $f['coll'] ? ['id' => $f['coll'], 'name' => 'Avengers Filmreihe'] : null,
        'genres' => [['id' => 28, 'name' => 'Action'], ['id' => 878, 'name' => 'Science Fiction']],
        'credits' => ['cast' => [['name' => 'Robert Downey Jr.', 'character' => 'Tony Stark', 'profile_path' => '/rdj.jpg'], ['name' => 'Scarlett Johansson', 'character' => 'Natasha', 'profile_path' => null]],
            'crew' => [['job' => 'Director', 'name' => 'Joss Whedon']]],
        'images' => ['posters' => [['iso_639_1' => 'de', 'file_path' => "/p{$id}de.jpg", 'vote_average' => 5]], 'backdrops' => [['iso_639_1' => null, 'file_path' => "/b$id.jpg"]],
            'logos' => [['iso_639_1' => 'de', 'file_path' => "/l$id.png"]]],
        'release_dates' => ['results' => [['iso_3166_1' => 'DE', 'release_dates' => [['certification' => '12']]]]],
    ]);
}
if ($pfad === '/3/collection/86311') {
    antwort(['id' => 86311, 'name' => 'Avengers Filmreihe', 'overview' => 'Alle Avengers-Filme.', 'poster_path' => '/coll.jpg', 'backdrop_path' => '/collb.jpg',
        'parts' => [['id' => 99861, 'release_date' => '2015-04-22'], ['id' => 24428, 'release_date' => '2012-04-25']]]);
}

// Serie „Haus des Geldes“: 1 Staffel mit 3 Folgen; Netflix-Schnitt als Episodengruppe (2 Teile)
if ($pfad === '/3/search/tv') {
    $wort = strtolower((string) ($q['query'] ?? ''));
    antwort(['results' => str_contains('haus des geldes', $wort) ? [['id' => 71446, 'name' => 'Haus des Geldes', 'original_name' => 'La casa de papel', 'first_air_date' => '2017-05-02', 'poster_path' => '/hdg.jpg', 'overview' => 'Ein Raub.']] : []]);
}
if ($pfad === '/3/tv/71446') {
    antwort(['id' => 71446, 'name' => 'Haus des Geldes', 'original_name' => 'La casa de papel', 'first_air_date' => '2017-05-02', 'last_air_date' => '2021-12-03',
        'status' => 'Ended', 'overview' => 'Ein genialer Plan.', 'vote_average' => 8.2, 'poster_path' => '/hdg.jpg', 'backdrop_path' => '/hdgb.jpg',
        'networks' => [['name' => 'Antena 3']], 'genres' => [['id' => 80, 'name' => 'Krimi']],
        'seasons' => [['season_number' => 1, 'poster_path' => '/s1.jpg']],
        'aggregate_credits' => ['cast' => [['name' => 'Úrsula Corberó', 'roles' => [['character' => 'Tokio']], 'profile_path' => '/uc.jpg']]],
        'images' => ['posters' => [], 'backdrops' => [], 'logos' => []], 'external_ids' => ['tvdb_id' => 327417, 'imdb_id' => 'tt6468322'],
        'content_ratings' => ['results' => [['iso_3166_1' => 'DE', 'rating' => '16']]],
        'episode_groups' => ['results' => [['id' => 'netflix1', 'name' => 'Netflix-Reihenfolge', 'type' => 4]]]]);
}
if ($pfad === '/3/tv/71446/season/1') {
    antwort(['name' => 'Staffel 1', 'overview' => 'Der Überfall beginnt.', 'poster_path' => '/s1.jpg', 'episodes' => [
        ['id' => 5001, 'episode_number' => 1, 'name' => 'Der Plan', 'overview' => 'Der Professor versammelt sein Team.', 'air_date' => '2017-05-02', 'runtime' => 47, 'still_path' => '/e1.jpg'],
        ['id' => 5002, 'episode_number' => 2, 'name' => 'Tödliche Nachlässigkeit', 'overview' => 'Die Geiseln werden unruhig.', 'air_date' => '2017-05-09', 'runtime' => 41, 'still_path' => '/e2.jpg'],
        ['id' => 5003, 'episode_number' => 3, 'name' => 'Falsch gezielt', 'overview' => 'Die Polizei kommt näher.', 'air_date' => '2017-05-16', 'runtime' => 50, 'still_path' => '/e3.jpg'],
    ]]);
}
if ($pfad === '/3/tv/episode_group/netflix1') {
    antwort(['id' => 'netflix1', 'name' => 'Netflix-Reihenfolge', 'type' => 4, 'description' => 'So wie bei Netflix', 'groups' => [
        ['name' => 'Teil 1', 'order' => 0, 'episodes' => [['season_number' => 1, 'episode_number' => 1, 'order' => 0], ['season_number' => 1, 'episode_number' => 2, 'order' => 1]]],
        ['name' => 'Teil 2', 'order' => 1, 'episodes' => [['season_number' => 1, 'episode_number' => 3, 'order' => 0]]],
    ]]);
}
http_response_code(404);
antwort(['status_message' => 'not found: ' . $pfad]);
