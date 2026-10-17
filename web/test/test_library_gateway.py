import base64
import hashlib
import hmac
import json
import unittest

from web.library_gateway import verify_ticket


class LibraryTickets(unittest.TestCase):
    def ticket(self, **overrides):
        data = {"path": "/api/library/videos", "method": "POST", "bytes": 100, "exp": 601000, "nonce": "a" * 32, **overrides}
        encoded = base64.urlsafe_b64encode(json.dumps(data).encode()).decode().rstrip("=")
        mac = hmac.new(b"test-secret", ("library-ticket." + encoded).encode(), hashlib.sha256).hexdigest()
        return encoded + "." + mac

    def test_valid_and_scoped(self):
        token = self.ticket()
        self.assertEqual(verify_ticket(token, "test-secret", "/api/library/videos", "POST", 1000)["bytes"], 100)
        for secret, path, method, now in [("wrong", "/api/library/videos", "POST", 1000), ("test-secret", "/api/library/config", "POST", 1000), ("test-secret", "/api/library/videos", "GET", 1000), ("test-secret", "/api/library/videos", "POST", 601000)]:
            self.assertIsNone(verify_ticket(token, secret, path, method, now))

    def test_invalid_or_overlong_expiry(self):
        self.assertIsNone(verify_ticket(self.ticket(exp=9999999), "test-secret", "/api/library/videos", "POST", 1000))
        for token in ["", "bad.token", self.ticket() + "tampered"]:
            self.assertIsNone(verify_ticket(token, "test-secret", "/api/library/videos", "POST", 1000))

    def test_head_works_for_a_playback_link(self):
        self.assertIsNotNone(verify_ticket(self.ticket(method="GET"), "test-secret", "/api/library/videos", "HEAD", 1000))


if __name__ == "__main__":
    unittest.main()
