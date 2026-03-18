<?php
declare(strict_types=1);

header('Content-Type: application/json; charset=UTF-8');
date_default_timezone_set('Europe/Vienna');

function respond(int $status, array $payload): void
{
    http_response_code($status);
    echo json_encode($payload, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    exit;
}

register_shutdown_function(static function (): void {
    $error = error_get_last();
    if ($error === null) {
        return;
    }

    $fatalTypes = [E_ERROR, E_PARSE, E_CORE_ERROR, E_COMPILE_ERROR, E_USER_ERROR];
    if (!in_array($error['type'] ?? null, $fatalTypes, true)) {
        return;
    }

    if (!headers_sent()) {
        http_response_code(500);
        header('Content-Type: application/json; charset=UTF-8');
    }

    if (ob_get_length()) {
        @ob_clean();
    }

    echo json_encode([
        'message' => 'Serverfehler beim Versand: ' . (string) ($error['message'] ?? 'Unbekannter Fehler'),
    ], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
});

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    respond(405, ['message' => 'Method not allowed.']);
}

function env_value(string $key, ?string $default = null): ?string
{
    $value = getenv($key);
    if ($value !== false && $value !== '') {
        return $value;
    }

    if (isset($_ENV[$key]) && $_ENV[$key] !== '') {
        return (string) $_ENV[$key];
    }

    if (isset($_SERVER[$key]) && $_SERVER[$key] !== '') {
        return (string) $_SERVER[$key];
    }

    return $default;
}

function esc(?string $value): string
{
    return htmlspecialchars((string) $value, ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8');
}

function client_ip(): string
{
    $keys = ['HTTP_CF_CONNECTING_IP', 'HTTP_X_FORWARDED_FOR', 'REMOTE_ADDR'];
    foreach ($keys as $key) {
        if (!empty($_SERVER[$key])) {
            $value = (string) $_SERVER[$key];
            if ($key === 'HTTP_X_FORWARDED_FOR') {
                $parts = explode(',', $value);
                return trim($parts[0]);
            }
            return trim($value);
        }
    }

    return 'unknown';
}

$rawBody = file_get_contents('php://input');
$payload = json_decode($rawBody ?: '', true);

if (!is_array($payload)) {
    respond(400, ['message' => 'Invalid request payload.']);
}

$name = trim((string) ($payload['name'] ?? ''));
$company = trim((string) ($payload['company'] ?? ''));
$email = trim((string) ($payload['email'] ?? ''));
$goal = trim((string) ($payload['goal'] ?? ''));
$package = trim((string) ($payload['package'] ?? ''));
$packagePrice = trim((string) ($payload['packagePrice'] ?? ''));
$maintenance = trim((string) ($payload['maintenance'] ?? ''));
$budget = trim((string) ($payload['budget'] ?? ''));
$timeline = trim((string) ($payload['timeline'] ?? ''));
$mailBody = trim((string) ($payload['mailBody'] ?? ''));
$website = trim((string) ($payload['website'] ?? ''));
$formStartedAt = (string) ($payload['formStartedAt'] ?? '');
$addons = $payload['addons'] ?? [];

if ($name === '' || $goal === '' || $package === '' || !filter_var($email, FILTER_VALIDATE_EMAIL)) {
    respond(422, ['message' => 'Bitte fülle Name, E-Mail, Paket und Projektziel aus.']);
}

if ($website !== '') {
    respond(400, ['message' => 'Anfrage konnte nicht verarbeitet werden.']);
}

$startedAtMs = ctype_digit($formStartedAt) ? (int) $formStartedAt : 0;
if ($startedAtMs <= 0) {
    respond(400, ['message' => 'Bitte lade die Seite neu und versuche es erneut.']);
}

$elapsedMs = (int) floor(microtime(true) * 1000) - $startedAtMs;
if ($elapsedMs < 3500) {
    respond(429, ['message' => 'Die Anfrage wurde zu schnell gesendet. Bitte versuche es in ein paar Sekunden erneut.']);
}

$ip = client_ip();
$rateLimitFile = rtrim(sys_get_temp_dir(), DIRECTORY_SEPARATOR) . DIRECTORY_SEPARATOR . 'crowforge_services_rate_' . sha1($ip) . '.json';
$now = time();
$cooldownSeconds = 45;

if (is_file($rateLimitFile)) {
    $stored = json_decode((string) file_get_contents($rateLimitFile), true);
    $lastRequest = is_array($stored) && isset($stored['time']) ? (int) $stored['time'] : 0;
    if ($lastRequest > 0 && ($now - $lastRequest) < $cooldownSeconds) {
        respond(429, ['message' => 'Bitte warte kurz, bevor du eine weitere Anfrage sendest.']);
    }
}

@file_put_contents($rateLimitFile, json_encode(['time' => $now]));

if (!is_array($addons)) {
    $addons = [];
}

$resendApiKey = env_value('RESEND_API_KEY');
$resendFrom = env_value('RESEND_FROM', 'CROWFORGE Web Services <contact@crowforge-games.com>');
$resendTo = env_value('RESEND_TO', 'contact@crowforge-games.com');

if ($resendApiKey === null) {
    respond(500, ['message' => 'RESEND_API_KEY ist serverseitig nicht gesetzt.']);
}

if (!function_exists('curl_init')) {
    respond(500, ['message' => 'PHP cURL ist auf dem Server nicht aktiv. Bitte aktiviere die cURL-Erweiterung.']);
}

$addonItems = '';
if ($addons !== []) {
    foreach ($addons as $addon) {
        $addonItems .= '<li>' . esc((string) $addon) . '</li>';
    }
} else {
    $addonItems = '<li>Keine Add-ons ausgew&auml;hlt</li>';
}

$html = '
  <div style="font-family:Inter,Segoe UI,Arial,sans-serif;color:#111827;line-height:1.65">
    <h2 style="margin:0 0 16px;font-size:24px">Neue Anfrage &uuml;ber CROWFORGE Web Services</h2>
    <p style="margin:0 0 20px">Es wurde eine neue Projektanfrage &uuml;ber die Services-Seite gesendet.</p>

    <table style="width:100%;border-collapse:collapse;margin:0 0 20px">
      <tr><td style="padding:8px 0;font-weight:700;width:180px">Paket</td><td style="padding:8px 0">' . esc($package) . '</td></tr>
      <tr><td style="padding:8px 0;font-weight:700">Preisrahmen Paket</td><td style="padding:8px 0">' . esc($packagePrice) . '</td></tr>
      <tr><td style="padding:8px 0;font-weight:700">Wartung</td><td style="padding:8px 0">' . esc($maintenance) . '</td></tr>
      <tr><td style="padding:8px 0;font-weight:700">Budget</td><td style="padding:8px 0">' . esc($budget) . '</td></tr>
      <tr><td style="padding:8px 0;font-weight:700">Zeitrahmen</td><td style="padding:8px 0">' . esc($timeline) . '</td></tr>
      <tr><td style="padding:8px 0;font-weight:700">Name</td><td style="padding:8px 0">' . esc($name) . '</td></tr>
      <tr><td style="padding:8px 0;font-weight:700">Unternehmen</td><td style="padding:8px 0">' . ($company !== '' ? esc($company) : '-') . '</td></tr>
      <tr><td style="padding:8px 0;font-weight:700">E-Mail</td><td style="padding:8px 0">' . esc($email) . '</td></tr>
    </table>

    <h3 style="margin:0 0 10px;font-size:18px">Add-ons</h3>
    <ul style="margin:0 0 20px 18px;padding:0">' . $addonItems . '</ul>

    <h3 style="margin:0 0 10px;font-size:18px">Projektziel / Infos</h3>
    <div style="padding:14px 16px;border:1px solid #e5e7eb;background:#f8fafc;white-space:pre-wrap">' . nl2br(esc($goal)) . '</div>

    <h3 style="margin:24px 0 10px;font-size:18px">Textversion</h3>
    <div style="padding:14px 16px;border:1px solid #e5e7eb;background:#ffffff;white-space:pre-wrap">' . nl2br(esc($mailBody)) . '</div>
  </div>
';

$requestBody = [
    'from' => $resendFrom,
    'to' => [$resendTo],
    'reply_to' => $email,
    'subject' => 'Neue Web Services Anfrage - ' . $package,
    'html' => $html,
    'text' => $mailBody !== '' ? $mailBody : $goal,
];

$ch = curl_init('https://api.resend.com/emails');
curl_setopt_array($ch, [
    CURLOPT_POST => true,
    CURLOPT_RETURNTRANSFER => true,
    CURLOPT_HTTPHEADER => [
        'Authorization: Bearer ' . $resendApiKey,
        'Content-Type: application/json',
        'Idempotency-Key: ' . bin2hex(random_bytes(12)),
    ],
    CURLOPT_POSTFIELDS => json_encode($requestBody, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES),
]);

$response = curl_exec($ch);
$curlError = curl_error($ch);
$httpCode = (int) curl_getinfo($ch, CURLINFO_HTTP_CODE);
curl_close($ch);

if ($response === false) {
    respond(500, ['message' => 'Resend konnte nicht erreicht werden: ' . $curlError]);
}

$decodedResponse = json_decode($response, true);

if ($httpCode < 200 || $httpCode >= 300) {
    $message = 'Versand fehlgeschlagen.';
    if (is_array($decodedResponse) && isset($decodedResponse['message'])) {
        $message = (string) $decodedResponse['message'];
    }
    respond(500, ['message' => $message]);
}

respond(200, [
    'message' => 'Anfrage erfolgreich gesendet.',
    'id' => is_array($decodedResponse) ? ($decodedResponse['id'] ?? null) : null,
]);
