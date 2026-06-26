# Tracking Implementation Configuration

## UTM Parameter Standards
All marketing-driven links must follow this naming convention to ensure consistency:
- `source`: The origin of traffic (e.g., `google`, `newsletter`, `linkedin`).
- `medium`: The marketing medium (e.g., `cpc`, `email`, `social`).
- `campaign`: The specific campaign name (e.g., `summer_sale_2024`).
- `content`: Used to distinguish different content within the same ad (e.g., `variant_a`, `variant_b`).
- `term`: Used for paid search keywords.

## GA4 Custom Events
The following events are tracked in GA4:

| Event Name | Trigger | Parameters to Capture |
| :--- | :--- | :--- |
| `sign_up` | Successful registration form submission | `method_type` (form, social, manual), `page_location` |
| `demo_requested` | Demo form submission | `product_type` (pro, enterprise), `user_source` |
| `document_download` | Click on PDF/resource download | `file_name`, `file_extension`, `file_type` |

## Implementation Notes
- Ensure GA4 tags are deployed via Google Tag Manager (GTM).
- UTM parameters must be appended to all outbound marketing links.
- Custom events should be validated in the GA4 DebugView.
