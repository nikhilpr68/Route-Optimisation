module.exports = {
  type: 'object',
  required: ['schema_version', 'problem_type', 'employees', 'vehicles'],
  additionalProperties: true,
  properties: {
    schema_version: { type: 'string' },
    problem_type: { type: 'string' },

    metadata: {
      type: 'object',
      additionalProperties: true,
      properties: {
        project_name: { type: ['string', 'null'] },
        date: { type: ['string', 'null'] },
        avg_speed_kmph: { type: ['number', 'null'] },
        distance_metric: { type: ['string', 'null'] }
      }
    },

    depot: {
      type: 'object',
      additionalProperties: true,
      properties: {
        lat: { type: ['number', 'null'] },
        lng: { type: ['number', 'null'] },
        name: { type: ['string', 'null'] }
      }
    },

    employees: {
      type: 'array',
      items: {
        type: 'object',
        required: ['id', 'pickup', 'dropoff'],
        additionalProperties: true,
        properties: {
          id: { type: 'string' },
          name: { type: ['string', 'null'] },
          priority: { type: ['string', 'number', 'null'] },

          pickup: {
            type: 'object',
            required: ['lat', 'lng'],
            additionalProperties: true,
            properties: {
              lat: { type: ['number', 'null'] },
              lng: { type: ['number', 'null'] },
              address: { type: ['string', 'null'] }
            }
          },

          dropoff: {
            type: 'object',
            required: ['lat', 'lng'],
            additionalProperties: true,
            properties: {
              lat: { type: ['number', 'null'] },
              lng: { type: ['number', 'null'] },
              address: { type: ['string', 'null'] }
            }
          },

          time_window: {
            type: 'object',
            additionalProperties: true,
            properties: {
              start: { type: ['string', 'null'] },
              end: { type: ['string', 'null'] }
            }
          }
        }
      }
    },

    vehicles: {
      type: 'array',
      items: {
        type: 'object',
        required: ['id', 'capacity', 'start_location'],
        additionalProperties: true,
        properties: {
          id: { type: 'string' },
          mode: { type: ['string', 'null'] },
          capacity: { type: ['number', 'null'] },
          cost_per_km: { type: ['number', 'null'] },

          start_location: {
            type: 'object',
            required: ['lat', 'lng'],
            additionalProperties: true,
            properties: {
              lat: { type: ['number', 'null'] },
              lng: { type: ['number', 'null'] },
              address: { type: ['string', 'null'] }
            }
          },

          available_time: { type: ['string', 'null'] }
        }
      }
    },

    baseline: { type: 'object', additionalProperties: true }
  }
};