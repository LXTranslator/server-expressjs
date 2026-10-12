'use strict';

const { DataTypes } = require('sequelize');

/**
 * Column definitions most tables share.
 *
 * Each helper returns a new object on every call. Sequelize writes into the
 * attribute objects it is given, so one object shared between two models would
 * carry the first model's details into the second.
 */

/**
 * A random UUID primary key.
 *
 * @returns {object} Attribute definition for `id`.
 */
function uuidKey() {
  return {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true,
  };
}

/**
 * A column pointing at another table's `id`.
 *
 * Every reference a model declares cascades on delete and on update, so a
 * parent row never leaves an orphan behind.
 *
 * @param {string} table Referenced table name.
 * @param {string} field Column name in this table.
 * @param {object} [options] Overrides.
 * @param {import('sequelize').DataType} [options.type] Column type, UUID unless
 *   the parent uses an integer key.
 * @param {boolean} [options.allowNull] Whether the reference is optional.
 * @returns {object} Attribute definition.
 */
function reference(table, field, { type = DataTypes.UUID, allowNull = false } = {}) {
  return {
    type,
    allowNull,
    field,
    references: { model: table, key: 'id' },
    onDelete: 'CASCADE',
    onUpdate: 'CASCADE',
  };
}

/**
 * The `created_at` column, filled in when the row is inserted.
 *
 * @returns {object} Attribute definition for `createdAt`.
 */
function createdAt() {
  return {
    type: DataTypes.DATE,
    allowNull: false,
    defaultValue: DataTypes.NOW,
    field: 'created_at',
  };
}

module.exports = { uuidKey, reference, createdAt };
