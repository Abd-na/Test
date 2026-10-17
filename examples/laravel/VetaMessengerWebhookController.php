<?php

namespace App\Http\Controllers;

use App\Services\VetaMessenger;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Log;

/**
 * routes/api.php:
 *   Route::post('/webhooks/messenger', \App\Http\Controllers\VetaMessengerWebhookController::class);
 * (routes in api.php are not CSRF protected)
 */
class VetaMessengerWebhookController extends Controller
{
    public function __invoke(Request $request)
    {
        if (!VetaMessenger::validSignature(
            $request->getContent(),
            $request->header('X-Veta-Timestamp'),
            $request->header('X-Veta-Signature'),
        )) {
            abort(401, 'Invalid signature');
        }

        $event = $request->input('event');
        $data = $request->input('data', []);

        switch ($event) {
            case 'message.received':
                // $data['channel'] (whatsapp|sms), $data['from'], $data['text'], $data['media_url'] ...
                Log::info('Incoming message', ['from' => $data['from'] ?? null, 'text' => $data['text'] ?? null]);
                break;

            case 'message.delivered':
            case 'message.read':
            case 'message.failed':
                // update your own records using $data['id'] or $data['reference']
                break;

            case 'instance.disconnected':
            case 'instance.logged_out':
            case 'device.offline':
                // alert an admin: WhatsApp number or SMS phone went offline
                Log::warning("Veta Messenger: {$event}", $data);
                break;
        }

        return response()->json(['ok' => true]);
    }
}
